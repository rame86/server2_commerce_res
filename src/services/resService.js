// src/services/resService.js

/**
 * FanVerse(LuminaPulse) - Reservation Service Layer
 * 핵심 변경 사항:
 * 1. RabbitMQ 직접 연결 로직 완전 제거 (Controller -> Queue 위임)
 * 2. Redis 실시간 재고 선차감(decrBy) 및 에러 발생 시 자동 롤백(incrBy) 적용
 */

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
 * [핵심] 예약 검증 및 준비 (네 원본 로직 100% 유지)
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

        const totalPrice = (event.price * count) + (count * 1000);

        // 4. 포인트 잔액 검증
        if (userBalance < totalPrice) {
            throw { 
                status: 400, 
                message: `포인트가 부족합니다. (필요: ${totalPrice}P / 보유: ${userBalance}P)` 
            };
        }

        const ticketCode = `TKT-${Math.floor(Math.random() * 90000) + 10000}`;

        return {
            totalPrice,
            ticketCode,
            eventTitle: event.title,
            remainingStock 
        };

    } catch (err) {
        // [중요 보상 트랜잭션] 선차감 재고 원복
        await redis.incrBy(stockKey, count);
        throw err;
    }
};

/**
 * [티켓 예매 실행 (DB 저장)]
 */
const makeReservation = async (resData, memberId) => {
    const dbData = {
        event_id: parseInt(resData.event_id, 10),
        ticket_count: parseInt(resData.ticket_count, 10),
        member_id: memberId,
        total_price: resData.total_price,
        ticket_code: resData.ticket_code
    };

    const dbResult = await resRepository.createReservationWithTransaction(dbData);

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

// 💡 여기서 모든 함수를 한 번에 내보냄 (this 에러 방지)
module.exports = {
    warmupAllEventsToRedis,
    initEventStock,
    validateAndPrepare,
    makeReservation,
    processRefund
};