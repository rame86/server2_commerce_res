// src/services/eventService.js
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const redis = require('../config/redisClient');

/**
 * [전체 이벤트 재고 Redis Warm-up]
 * 서버 시작 시 또는 관리자 요청 시 DB의 재고를 Redis로 복사함
 */
exports.warmupAllEventsToRedis = async () => {
    try {
        // [1] 기존 재고 데이터 전체 삭제 (일관성을 위해 초기화)
        await redis.flushAll(); 
        console.log("🧹 [Redis] 기존 재고 데이터를 모두 삭제했습니다.");

        // [2] DB에서 현재 판매 중인 모든 이벤트 조회
        const events = await prisma.events.findMany({
            select: { event_id: true, available_seats: true }
        });

        // [3] Redis에 각 이벤트의 재고 세팅
        for (const event of events) {
            const stockKey = `event:stock:${event.event_id}`;
            await redis.set(stockKey, event.available_seats);
        }

        console.log(`🚀 [Warm-up] DB 기반으로 ${events.length}개 이벤트 재고 동기화 완료!`);
    } catch (err) {
        console.error("❌ Warm-up 중 오류 발생:", err);
        throw err; // 에러를 호출처(Controller)로 던짐
    }
};

/**
 * [좌표 변환] 카카오 REST API를 사용하여 주소를 위경도로 변환
 */
exports.getCoordinates = async (address) => {
    const KAKAO_API_KEY = process.env.KAKAO_REST_API_KEY; 
    const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURI(address)}`;

    try {
        const response = await axios.get(url, {
            headers: { Authorization: `KakaoAK ${KAKAO_API_KEY}` }
        });

        const document = response.data.documents[0];
        if (!document) return null;

        return {
            lat: parseFloat(document.y),
            lng: parseFloat(document.x) 
        };
    } catch (error) {
        console.error("❌ 카카오 API 호출 실패:", error.message);
        return null; // 좌표 변환 실패 시 null 반환하여 로직 계속 진행
    }
};

/**
 * [관리자용: Redis 단일 재고 세팅]
 */
exports.initEventStock = async (eventId, stockCount) => {
    const key = `event:stock:${eventId}`;
    await redis.set(key, stockCount);
    return { eventId, stockCount };
};