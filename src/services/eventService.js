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

/**
 * [좌표 변환] 카카오 REST API를 사용하여 주소를 위경도로 변환
 * -------------------------------------------------------------------------
 * 목적: 주소(텍스트)만 있는 데이터를 기반으로 지도에 핀을 찍기 위한 위/경도(숫자)를 획득함.
 * -------------------------------------------------------------------------
 */

exports.getCoordinates = async (address) => {
    // [환경 변수 활용] 보안을 위해 API 키는 소스코드에 하드코딩하지 않고 .env 파일에서 가져옴
    const KAKAO_API_KEY = process.env.KAKAO_REST_API_KEY; 
    
    /**
     * https://namu.wiki/w/%EC%9D%B8%EC%BD%94%EB%94%A9 주소 문자열에 포함된 공백이나 한글이 깨지지 않도록 
     * encodeURI를 사용하여 표준 URL 형식으로 변환함.
     */
    const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURI(address)}`;

    try {
        // [외부 API 호출] axios를 사용하여 카카오 서버에 GET 요청을 보내고 인증 헤더를 첨부함
        const response = await axios.get(url, {
            headers: { Authorization: `KakaoAK ${KAKAO_API_KEY}` }
        });

        /**
         * [데이터 정제]
         * 결과 배열 중 가장 유사도가 높은 첫 번째 검색 결과(documents[0])를 추출함.
         */
        const document = response.data.documents[0];
        // 검색 결과가 없는 경우 상위 로직에서 대응할 수 있도록 null을 반환함
        if (!document) return null;

        /**
         * [형변환 및 반환]
         * 카카오 API가 반환하는 문자열 좌표(y=위도, x=경도)를 
         * DB 저장 및 연산이 용이하도록 실수형(Float)으로 파싱하여 객체로 반환함.
         */
        return {
            lat: parseFloat(document.y),
            lng: parseFloat(document.x) 
        };
    } catch (error) {
        // [방어 코드] API 장애 시 전체 로직이 멈추지 않도록 에러 로깅 후 null을 반환하여 유연하게 대처함
        console.error("❌ 카카오 API 호출 실패:", error.message);
        return null; 
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
 * 컨슈머로부터 데이터를 받아 성공/실패 로직을 진두지휘함.
 */
exports.processAdminResponse = async (response) => {
    const { approvalId, status, admin_id, rejectionReason } = response;

    // 1. 원본 신청 데이터가 있는지 리포지토리에 물어봄
    const approvalReq = await eventRepository.findApprovalById(approvalId);
    if (!approvalReq) throw new Error(`승인 요청건을 찾을 수 없음: ${approvalId}`);

    if (status === 'CONFIRMED') {
        const snapshot = approvalReq.event_snapshot;

        // 가공된 데이터 세트 준비
        const eventData = {
            title: snapshot.title,
            artist_id: snapshot.artist_id,
            artist_name: snapshot.artist_name,
            event_type: snapshot.event_type,
            description: snapshot.description,
            price: snapshot.price,
            total_capacity: snapshot.total_capacity,
            available_seats: snapshot.total_capacity,
            event_date: snapshot.event_date,
            open_time: snapshot.open_time,
            close_time: snapshot.close_time,
            approval_status: 'CONFIRMED'
        };

        const locationData = {
            venue: snapshot.venue,
            address: snapshot.address
        };

        // 2. 트랜잭션 실행 (리포지토리 호출)
        return await prisma.$transaction(async (tx) => {
            return await eventRepository.confirmEvent(tx, eventData, locationData, approvalId, admin_id);
        });

    } else if (status === 'FAILED') {
        // 3. 반려 로직 수행
        return await eventRepository.updateApprovalFailed(approvalId, admin_id, rejectionReason);
    }
};
