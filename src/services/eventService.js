// src/services/eventService.js
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const redis = require('../config/redisClient');
const eventRepository = require('../repositories/eventRepository');

/**
 * [전체 이벤트 재고 Redis Warm-up]
 * -------------------------------------------------------------------------
 * 목적: 고트래픽 티켓팅 오픈 시 DB 부하를 원천 차단하기 위해, 
 * 미리 DB의 재고 데이터를 고성능 인메모리 DB인 Redis로 복사해두는 작업임.
 * -------------------------------------------------------------------------
 */
exports.warmupAllEventsToRedis = async () => {
    try {
        /**
         * [데이터 일관성 보장: 초기화]
         * DB와 Redis의 데이터가 꼬이는 것을 방지하기 위해, 
         * 동기화 전 기존 Redis에 저장된 낡은 재고 데이터를 모두 삭제함.
         */
        await redis.flushAll(); 
        console.log("🧹 [Redis] 기존 재고 데이터를 모두 삭제했습니다.");

        /**
         * [필요 데이터 최소 조회]
         * 모든 필드를 조회하지 않고, 'event_id'와 'available_seats'만 select하여 
         * DB 부하 및 메모리 사용량을 최적화함.
         */
        const events = await prisma.events.findMany({
            where: { approval_status: 'CONFIRMED' }, // 🌟 이 줄을 추가해!
            select: { event_id: true, available_seats: true }
        });

        /**
         * [반복 동기화]
         * 조회된 모든 공연에 대해 반복문을 돌며 Redis에 '키-값' 형태로 재고를 저장함.
         * 키 형식: 'event:stock:{id}' -> 이후 resService에서 이 키로 선차감을 수행함.
         */
        for (const event of events) {
            const stockKey = `event:stock:${event.event_id}`;
            // 각 공연의 실제 DB 잔여석 수량을 Redis 메모리에 세팅함
            await redis.set(stockKey, event.available_seats);
        }

        console.log(`🚀 [Warm-up] DB 기반으로 ${events.length}개 이벤트 재고 동기화 완료!`);
    } catch (err) {
        // [예외 전파] 에러 발생 시 로그를 남기고 상위 레이어(Controller)로 에러를 던져 적절한 응답을 유도함
        console.error("❌ Warm-up 중 오류 발생:", err);
        throw err; 
    }
};

exports.getCoordinates = async (address) => {
    try {
        const url = process.env.KAKAO_API_URL;
        
        // 🌟 [최종 병기] 모든 종류의 공백, 줄바꿈, 탭, 제어문자를 싹 다 제거
        const rawKey = process.env.KAKAO_REST_API_KEY || "";
        const cleanKey = rawKey.replace(/[\s\t\n\r]/g, "").trim(); 

        if (!cleanKey) {
            console.error("❌ KAKAO_REST_API_KEY가 비어있어!");
            return null;
        }

        const response = await axios.get(url, {
            params: { query: address },
            headers: {
                // 'KakaoAK ' 뒤에 공백 한 칸 확인!
                'Authorization': `KakaoAK ${cleanKey}`
            }
        });

        if (response.data.documents && response.data.documents.length > 0) {
            const { x, y } = response.data.documents[0];
            return { lat: parseFloat(y), lng: parseFloat(x) };
        }
        return null;

    } catch (error) {
        // 401 에러가 나면 cleanKey를 한 번 더 의심해야 해
        console.error("❌ 카카오 API 호출 최종 실패:", error.response?.data || error.message);
        throw error;
    }
};

/**
 * [관리자용: Redis 단일 재고 세팅]
 * -------------------------------------------------------------------------
 * 목적: 특정 이벤트의 재고만 수동으로 조절하거나, 테스트 시 특정 수량으로 세팅할 때 사용함.
 * -------------------------------------------------------------------------
 */
exports.initEventStock = async (eventId, stockCount) => {
    // [식별자 구성] Redis 표준 키 컨벤션을 유지함
    const key = `event:stock:${eventId}`;
    
    /**
     * [메모리 쓰기]
     * 지정된 이벤트 ID에 대해 입력받은 수량(stockCount)만큼 Redis 재고를 즉시 덮어씀.
     */
    await redis.set(key, stockCount);
    
    return { eventId, stockCount };
};

/**
 * [관리자 응답 처리 서비스]
 */
exports.processAdminResponse = async (response) => {
    // 🌟 1. Spring이 보낸 'eventId'를 먼저 잡고, 없으면 'approvalId'를 잡도록 수정!
    const incomingId = response.eventId || response.approvalId;
    const { status, admin_id, rejectionReason } = response;

    // 🌟 2. 위에서 잡은 incomingId가 있는지 확인 (아까 여기서 에러 난 거야)
    if (!incomingId) throw new Error("ID(eventId 또는 approvalId)가 전달되지 않았어!");

    // 🌟 3. Repository 호출할 때도 incomingId를 사용
    const approvalReq = await eventRepository.findApprovalById(incomingId);
    if (!approvalReq) throw new Error(`승인 요청건을 찾을 수 없음: ${incomingId}`);

    const actualEventId = approvalReq.event_id;

    // 트랜잭션 시작
    return await prisma.$transaction(async (tx) => {
        if (status === 'CONFIRMED') {
            return await eventRepository.confirmEvent(tx, actualEventId, admin_id);
        } else if (status === 'FAILED') {
            return await eventRepository.rejectEvent(tx, actualEventId, admin_id, rejectionReason);
        }
    });
};