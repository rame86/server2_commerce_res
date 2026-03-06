// src/services/resService.js

require('dotenv').config();
const resRepository = require('../repositories/resRepository');
const redis = require('../config/redisClient');
const { publishToQueue } = require('../config/rabbitMQ');

/**
 * [전체 이벤트 재고 Redis Warm-up]
 */
const warmupAllEventsToRedis = async () => {
    const allEvents = await resRepository.findAllEvents();
    if (!allEvents || allEvents.length === 0) {
        console.warn("⚠️ [Warm-up] DB에 로드할 이벤트가 없습니다.");
        return;
    }
    for (const event of allEvents) {
        const key = `event:stock:${event.event_id}`;
        await redis.set(key, event.available_seats);
    }
    console.log(`🚀 [Redis] ${allEvents.length}개 이벤트 동기화 완료`);
};

/**
 * [관리자용: Redis 단일 재고 초기 세팅]
 */
const initEventStock = async (eventId, stockCount) => {
    const key = `event:stock:${eventId}`;
    await redis.set(key, stockCount);
    return { eventId, stockCount };
};

/**
 * [핵심] 예약 검증 및 준비 (Controller에서 호출됨)
 */
const validateAndPrepare = async (eventId, count, memberId) => {
    const stockKey = `event:stock:${eventId}`;
    
    // 1. Redis에서 실시간 재고 선차감
    const remainingStock = await redis.decrBy(stockKey, count);

    if (remainingStock < 0) {
        await redis.incrBy(stockKey, count);
        throw { status: 400, message: "선착순 마감되었습니다. 재고가 부족합니다." };
    }

    try {
        // 2. Redis에서 유저 정보 가져오기
        const userKey = `AUTH:MEMBER:${memberId}`;
        const userProfile = await redis.hGetAll(userKey);

        if (!userProfile || Object.keys(userProfile).length === 0) {
            throw { status: 401, message: "유저 정보를 찾을 수 없습니다. 다시 로그인해주세요." };
        }

        const userBalance = parseInt(userProfile.balance, 10) || 0; 

        // 3. 이벤트 정보 조회 및 가격 계산
        const event = await resRepository.findEventById(eventId);
        if (!event) {
            throw { status: 404, message: "공연 정보를 찾을 수 없습니다." };
        }

        // 수수료 1000원 포함 계산
        const totalPrice = (event.price * count) + (count * 1000);

        // 4. 포인트 잔액 검증
        if (userBalance < totalPrice) {
            throw { 
                status: 400, 
                message: `포인트가 부족합니다. (필요: ${totalPrice}P / 보유: ${userBalance}P)` 
            };
        }

        // 짧고 깔끔한 티켓 코드 생성 (날짜 + 랜덤)
        const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, ''); // 260306
        const ticketCode = `TKT-${dateStr}-${Math.floor(Math.random() * 9000) + 1000}`;

        return {
            totalPrice,
            ticketCode,
            eventTitle: event.title,
            remainingStock 
        };

    } catch (err) {
        // 에러 시 재고 원복 (보상 트랜잭션)
        await redis.incrBy(stockKey, count);
        throw err;
    }
};

/**
 * [티켓 예매 실행 (DB 저장)] - Consumer에서 호출됨
 * 💡 수정 포인트: 데이터를 DB에 넣은 후, 다시 객체에 담아서 반환해야 결제 서버로 전달됨!
 */
const makeReservation = async (resData, memberId) => {
    // 1. DB 저장을 위한 데이터 매핑
    const dbData = {
        event_id: parseInt(resData.event_id, 10),
        ticket_count: parseInt(resData.ticket_count, 10),
        member_id: memberId,
        total_price: resData.totalPrice || resData.total_price, // validateAndPrepare에서 온 값 우선
        ticket_code: resData.ticketCode || resData.ticket_code
    };

    // 2. DB 저장 실행
    const dbResult = await resRepository.createReservationWithTransaction(dbData);

    // 3. 🌟 중요: consumer.js가 결제 서버로 보낼 수 있도록 데이터를 업데이트해서 반환
    // resData 객체 자체에 값을 할당해줘야 참조 에러가 안 나
    resData.total_price = dbData.total_price;
    resData.ticket_code = dbData.ticket_code;

    console.log(`✅ [DB 저장 완료] 티켓번호: ${resData.ticket_code}`);

    // BigInt 처리 및 반환
    return JSON.parse(JSON.stringify(dbResult, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value
    ));
};

/**
 * [사용자 환불 요청 검증]
 */
const processRefund = async (ticketCode, memberId) => {
    if (!ticketCode) {
        throw { status: 400, message: "환불에 필요한 티켓 코드가 없습니다." };
    }

    const reservation = await resRepository.findReservationByCode(ticketCode);
    
    if (!reservation) {
        throw { status: 404, message: "예매 내역을 찾을 수 없습니다." };
    }
    
    if (String(reservation.member_id) !== String(memberId)) {
        throw { status: 403, message: "본인의 예매 내역만 환불할 수 있습니다." };
    }
    
    if (reservation.status === 'REFUNDED' || reservation.status === 'FAILED') {
        throw { status: 400, message: "이미 환불되거나 취소된 티켓입니다." };
    }

    return {
        ticket_code: ticketCode,
        member_id: memberId,
        cancel_amount: reservation.total_price 
    };
};

module.exports = {
    warmupAllEventsToRedis,
    initEventStock,
    validateAndPrepare,
    makeReservation,
    processRefund
};