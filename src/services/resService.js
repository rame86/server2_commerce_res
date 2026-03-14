// src/services/resService.js
require('dotenv').config();
        
const resRepository = require('../repositories/resRepository');
const eventRepository = require('../repositories/eventRepository');
const redis = require('../config/redisClient');

/**
 * [핵심] 예약 검증 및 준비
 * -------------------------------------------------------------------------
 * 목적: DB 부하를 줄이기 위해 Redis에서 재고를 선점하고, 결제 전 모든 자격을 검증함.
 * 흐름: Redis 재고 차감 -> 유저 세션 확인 -> 티켓 가격 계산 -> 유저 잔액 검증
 * -------------------------------------------------------------------------
 */
exports.validateAndPrepare = async (eventId, count, memberId) => {
    // 🌟 수량 제한 로직: 2개 초과 시 바로 에러 발생
    if (count > 2) {
        throw { status: 400, message: "티켓은 1인당 최대 2매까지만 예매 가능합니다." };
    }

    // [식별자 구성] 해당 공연의 Redis 재고 키를 생성함
    const stockKey = `event:stock:${eventId}`;
    
    /**
     * [Step 1: Redis 원자적 재고 차감]
     * decrBy는 여러 서버가 동시에 요청해도 숫자를 꼬이지 않게 하나씩 줄여주는 Atomic 연산임.
     * DB를 찌르기 전에 메모리에서 먼저 재고를 깎아 고속 처리를 가능케 함.
     */
    const remainingStock = await redis.decrBy(stockKey, count);

    /**
     * [재고 부족 핸들링]
     * 숫자가 0보다 작아졌다면 방금 내가 깎은 수량 때문에 재고가 바닥난 것임.
     * 즉시 다시 incrBy를 호출하여 재고를 복구(Rollback)하고 에러를 던져 예약을 중단함.
     */
    if (remainingStock < 0) {
        await redis.incrBy(stockKey, count);
        throw { status: 400, message: "선착순 마감되었습니다. 재고가 부족합니다." };
    }

    try {
        /**
         * [Step 2: 유저 세션 및 프로필 조회]
         * Redis에 저장된 유저의 최신 상태(인증 여부, 잔액 등)를 Hash 형태로 가져옴.
         */
        const userKey = `AUTH:MEMBER:${memberId}`;
        const userProfile = await redis.hGetAll(userKey);

        // [인증 검증] 유저 세션 키가 없거나 데이터가 비어있다면 로그아웃 상태로 간주함
        if (!userProfile || Object.keys(userProfile).length === 0) {
            throw { status: 401, message: "유저 정보를 찾을 수 없습니다. 다시 로그인해주세요." };
        }

        /**
         * [잔액 추출] Redis 프로필 데이터 중 balance 필드를 정수형으로 파싱함
         */
        const userBalance = parseInt(userProfile.balance, 10) || 0; 

        /**
         * [Step 3: 공연 정보 조회 및 금액 산출]
         * eventRepository를 통해 DB에서 공연 단가(price)를 가져옴.
         * 총 금액 = (공연가 * 매수) + (수수료 * 매수)로 계산함.
         */
        const event = await eventRepository.findEventById(eventId);
        if (!event) throw { status: 404, message: "공연 정보를 찾을 수 없습니다." };
        
        // 🌟 [추가] 컨트롤러에 넘겨줄 아티스트 판매 수수료율을 DB에서 조회함
        // DB 직접 찌르지 않고 레포지토리 함수 호출!
        const feePolicy = await eventRepository.getFeePolicy(eventId);
        const salesCommissionRate = feePolicy ? feePolicy.sales_commission_rate : 0; // 정책이 없으면 안전하게 0 처리

        const bookingFee = count * 1000;
        const totalPrice = (event.price * count) + (count * 1000);

        /**
         * [Step 4: 결제 능력 검증]
         * 유저가 보유한 포인트(balance)가 방금 계산한 총 금액보다 적으면 예매를 차단함.
         */
        if (userBalance < totalPrice) {
            throw { 
                status: 400, 
                message: `포인트가 부족합니다. (필요: ${totalPrice}P / 보유: ${userBalance}P)` 
            };
        }

        /**
         * [Step 5: 고유 티켓 코드 생성]
         * TKT-날짜(6자리)-랜덤(4자리) 조합으로 중복 가능성을 최소화한 예매 식별자를 생성함.
         */
        const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, ''); 
        const ticketCode = `TKT-${dateStr}-${Math.floor(Math.random() * 9000) + 1000}`;

        // [결과 반환] 모든 검증이 끝나면 Controller에서 사용할 최종 예약 명세서를 넘겨줌
        return { 
            ticketCode: ticketCode,           // 통일
            memberId: Number(memberId),       // 통일
            totalPrice: totalPrice,           // 통일
            quantity: count,                  // ticket_count 대신 quantity로 통일
            artistId: event.artist_id,        // 통일
            ticketPrice: event.price,         // 통일
            salesCommissionRate: salesCommissionRate, 
            eventTitle: event.title,
            bookingFee: bookingFee            // DB 저장용 
        };

    } catch (err) {
        /**
         * [보상 트랜잭션: Redis 원복]
         * 유저 검증, 가격 계산, 잔액 부족 등 로직 수행 중 하나라도 실패하면 
         * 위에서 미리 깎아두었던 Redis 재고를 다시 원래대로 돌려주어야 함.
         */
        await redis.incrBy(stockKey, count);
        throw err;
    }
};

/**
 * [티켓 예매 실행] DB에 PENDING 상태로 예약 데이터 저장
 * -------------------------------------------------------------------------
 * 목적: Redis 검증이 끝난 데이터를 관계형 DB(PostgreSQL)에 영구 기록함.
 * -------------------------------------------------------------------------
 */
exports.makeReservation = async (resData, memberId) => {
    /**
     * [DB 데이터 정제]
     * Repository에 전달하기 전, 모든 데이터를 정수형으로 변환하여 스키마 타입과 일치시킴.
     */
    const dbData = {
        event_id: parseInt(resData.event_id, 10),
        ticket_count: parseInt(resData.ticket_count, 10),
        member_id: memberId,
        total_price: resData.totalPrice || resData.total_price,
        booking_fee: resData.bookingFee || resData.booking_fee,
        ticket_code: resData.ticketCode || resData.ticket_code,
        selected_seats: resData.selected_seats || null
    };

    /**
     * [DB 트랜잭션 실행]
     * 리포지토리를 통해 'DB 재고 차감'과 '예약 레코드 삽입'을 원자적으로 처리함.
     */
    const dbResult = await resRepository.createReservationWithTransaction(dbData);

    /**
     * [데이터 바인딩]
     * 실제 DB에 저장된 최종 티켓 코드와 금액을 결과 객체에 다시 동기화함.
     */
    resData.total_price = dbData.total_price;
    resData.ticket_code = dbData.ticket_code;

    console.log(`✅ [DB 저장 완료] 티켓번호: ${resData.ticket_code}`);

    /**
     * [결과 직렬화]
     * Prisma 결과의 BigInt 타입을 String으로 변환하여 JSON 응답 시 에러가 나지 않게 함.
     */
    return JSON.parse(JSON.stringify(dbResult, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value
    ));
};

/**
 * [사용자 환불 요청 검증] 환불 가능 상태인지 체크
 * -------------------------------------------------------------------------
 * 목적: 사용자가 환불을 요청했을 때, 실제 본인 티켓인지와 환불 가능한 상태인지를 검사함.
 * -------------------------------------------------------------------------
 */
exports.processRefund = async (ticketCode, memberId) => {
    // [유효성 검사] 필수 인자인 티켓 코드가 들어왔는지 확인
    if (!ticketCode) throw { status: 400, message: "환불에 필요한 티켓 코드가 없습니다." };

    /**
     * [예약 데이터 조회]
     * 입력받은 코드로 실제 DB에 저장된 예약 건이 있는지 확인함.
     */
    const reservation = await resRepository.findReservationByCode(ticketCode);
    
    // [부존재 예외] 잘못된 티켓 코드 요청에 대응
    if (!reservation) throw { status: 404, message: "예매 내역을 찾을 수 없습니다." };
    
    /**
     * [소유권 검증]
     * 요청자(memberId)와 티켓 소유자(reservation.member_id)를 비교하여 
     * 타인의 티켓을 환불하는 어뷰징 행위를 차단함.
     */
    if (String(reservation.member_id) !== String(memberId)) {
        throw { status: 403, message: "본인의 예매 내역만 환불할 수 있습니다." };
    }
    
    /**
     * [상태 검증]
     * 이미 환불되었거나 결제 실패한 티켓을 다시 환불 요청할 수 없도록 차단함.
     */
    if (['REFUNDED', 'FAILED'].includes(reservation.status)) {
        throw { status: 400, message: "이미 환불되거나 취소된 티켓입니다." };
    }

    // 🌟 [추가] 환불 정산 취소를 위해 원래 공연의 가격(price)과 수수료율 조회
    const event = await eventRepository.findEventById(reservation.event_id);
    // 환불할 때도 레포지토리 함수 호출!
    const feePolicy = await eventRepository.getFeePolicy(reservation.event_id);
    const salesCommissionRate = feePolicy ? feePolicy.sales_commission_rate : 0;

    /**
     * [환불 명세서 반환]
     * 검증이 모두 통과되면 결제 서버로 보낼 메시지 구성에 필요한 최소 정보를 반환함.
     */
   return {
        ticketCode: ticketCode,
        memberId: Number(memberId),
        totalPrice: reservation.total_price, 
        quantity: reservation.ticket_count, // 🚩 이름을 quantity로 확정
        artistId: event ? event.artist_id : null,
        ticketPrice: event ? event.price : 0,
        salesCommissionRate: salesCommissionRate,
        eventTitle: event ? event.title : "환불 요청"
        // 💡 bookingFee는 자바에서 안 받으므로 리턴에서 제외하거나 무시
    };
};

/**
 * [관리자 환불 승인 요청 준비] - 2번 과제 추가 로직
 * -------------------------------------------------------------------------
 * 목적: 사용자가 환불 요청 시 즉시 취소하지 않고, 관리자 승인 대기 상태(PENDING)로
 * reservation_refunds 테이블에 기록을 남긴 뒤, 큐 전송용 데이터를 반환함.
 * -------------------------------------------------------------------------
 */
exports.prepareRefundAdminRequest = async (ticketCode, memberId, refundReason) => {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();

    // 1. 기존 processRefund 로직을 재활용하여 자격 검증 및 기본 데이터(금액, 아티스트 정보 등)를 가져옴
    const refundPayload = await this.processRefund(ticketCode, memberId);

    // 2. 예약 데이터 조회 (processRefund에서 이미 검증했지만, reservation_id가 필요하므로 다시 가져옴)
    const reservation = await resRepository.findReservationByCode(ticketCode);
    if (!reservation) throw { status: 404, message: "예매 내역을 찾을 수 없습니다." };

    try {
        // 3. 트랜잭션: 환불 테이블에 기록 & 기존 예약 상태를 'REFUND_PENDING'으로 변경
        const refundRecord = await prisma.$transaction(async (tx) => {
            
            // a. reservation_refunds 테이블에 PENDING 상태로 데이터 삽입
            const newRefund = await tx.reservation_refunds.create({
                data: {
                    reservation_id: reservation.reservation_id,
                    member_id: BigInt(memberId),
                    refund_amount: refundPayload.totalPrice,
                    refund_reason: refundReason || "단순 변심",
                    status: 'PENDING'
                }
            });

            // b. reservations 테이블의 상태를 변경하여 중복 환불 요청이나 사용을 막음
            // (참고: 기존 스키마에 REFUND_PENDING 상태가 정의되어 있다고 가정)
            await tx.reservations.update({
                where: { reservation_id: reservation.reservation_id },
                data: { status: 'REFUND_PENDING', updated_at: new Date() }
            });

            return newRefund;
        });

        console.log(`✅ [환불 요청 DB 저장] RefundID: ${refundRecord.refund_id}, 상태: PENDING`);

        // 4. 컨트롤러가 관리자 큐(RabbitMQ)로 전송하기 좋게 기존 payload에 생성된 환불 ID를 합쳐서 반환
        return {
            ...refundPayload, // ticketCode, totalPrice, artistId 등 모두 포함
            refund_id: refundRecord.refund_id
        };

    } catch (error) {
        console.error("❌ 환불 DB 저장 중 오류 발생:", error);
        throw { status: 500, message: "환불 요청을 처리하는 중 서버 오류가 발생했습니다." };
    }
};

/**
 * [내 예매 내역 서비스]
 */
exports.getMyReservations = async (memberId) => {
    const reservations = await resRepository.findReservationsByMemberId(memberId);

    return reservations.map(res => ({
        reservation_id: res.reservation_id, // UUID는 그대로 문자열 처리됨
        ticket_code: res.ticket_code,
        status: res.status,
        ticket_count: res.ticket_count,
        pure_price: res.total_price - res.booking_fee,
        // 🌟 스냅샷에 있던 좌석 정보도 필요하면 포함
        selected_seats: res.selected_seats, 
        events: {
            title: res.events.title,
            artist_name: res.events.artist_name, // 아티스트명 추가
            event_date: res.events.event_date,
            // 🌟 b.events.event_locations.venue 경로 대응
            event_locations: {
                venue: res.events.event_locations?.venue || "장소 정보 없음"
            },
            poster: res.events.event_images[0]?.image_url || null
        },
        booked_at: res.booked_at
    }));
};

