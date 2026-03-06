// src/services/resService.js
require('dotenv').config();
const resRepository = require('../repositories/resRepository');
const redis = require('../config/redisClient');

/**
 * [핵심] 예약 검증 및 준비
 * 1. Redis 재고 차감 2. 유저 검증 3. 가격 계산 4. 포인트 확인
 */
exports.validateAndPrepare = async (eventId, count, memberId) => {
    const stockKey = `event:stock:${eventId}`;
    
    // [1] Redis에서 실시간 재고 선차감 (Atomic Operation)
    const remainingStock = await redis.decrBy(stockKey, count);

    // 재고가 부족하면 즉시 롤백 후 에러 반환
    if (remainingStock < 0) {
        await redis.incrBy(stockKey, count);
        throw { status: 400, message: "선착순 마감되었습니다. 재고가 부족합니다." };
    }

    try {
        // [2] Redis에서 유저 세션 정보 가져오기
        const userKey = `AUTH:MEMBER:${memberId}`;
        const userProfile = await redis.hGetAll(userKey);

        if (!userProfile || Object.keys(userProfile).length === 0) {
            throw { status: 401, message: "유저 정보를 찾을 수 없습니다. 다시 로그인해주세요." };
        }

        const userBalance = parseInt(userProfile.balance, 10) || 0; 

        // [3] 이벤트 가격 조회 및 총 금액 계산 (수수료 1000원 포함)
        const event = await resRepository.findEventById(eventId);
        if (!event) throw { status: 404, message: "공연 정보를 찾을 수 없습니다." };

        const totalPrice = (event.price * count) + (count * 1000);

        // [4] 포인트 잔액 검증
        if (userBalance < totalPrice) {
            throw { 
                status: 400, 
                message: `포인트가 부족합니다. (필요: ${totalPrice}P / 보유: ${userBalance}P)` 
            };
        }

        // [5] 티켓 코드 생성 (TKT-YYMMDD-랜덤4자리)
        const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, ''); 
        const ticketCode = `TKT-${dateStr}-${Math.floor(Math.random() * 9000) + 1000}`;

        return { totalPrice, ticketCode, eventTitle: event.title, remainingStock };

    } catch (err) {
        // 로직 실패 시 선차감했던 재고 원복 (보상 트랜잭션)
        await redis.incrBy(stockKey, count);
        throw err;
    }
};

/**
 * [티켓 예매 실행] DB에 PENDING 상태로 예약 데이터 저장
 */
exports.makeReservation = async (resData, memberId) => {
    const dbData = {
        event_id: parseInt(resData.event_id, 10),
        ticket_count: parseInt(resData.ticket_count, 10),
        member_id: memberId,
        total_price: resData.totalPrice || resData.total_price,
        ticket_code: resData.ticketCode || resData.ticket_code
    };

    const dbResult = await resRepository.createReservationWithTransaction(dbData);

    // 반환 객체에 값 보정 (Controller 전달용)
    resData.total_price = dbData.total_price;
    resData.ticket_code = dbData.ticket_code;

    console.log(`✅ [DB 저장 완료] 티켓번호: ${resData.ticket_code}`);

    return JSON.parse(JSON.stringify(dbResult, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value
    ));
};

/**
 * [사용자 환불 요청 검증] 환불 가능 상태인지 체크
 */
exports.processRefund = async (ticketCode, memberId) => {
    if (!ticketCode) throw { status: 400, message: "환불에 필요한 티켓 코드가 없습니다." };

    const reservation = await resRepository.findReservationByCode(ticketCode);
    
    if (!reservation) throw { status: 404, message: "예매 내역을 찾을 수 없습니다." };
    
    if (String(reservation.member_id) !== String(memberId)) {
        throw { status: 403, message: "본인의 예매 내역만 환불할 수 있습니다." };
    }
    
    if (['REFUNDED', 'FAILED'].includes(reservation.status)) {
        throw { status: 400, message: "이미 환불되거나 취소된 티켓입니다." };
    }

    return {
        ticket_code: ticketCode,
        member_id: memberId,
        cancel_amount: reservation.total_price 
    };
};