const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const redis = require('../config/redisClient');
const eventRepository = require('../repositories/eventRepository');
const { SCALE_POLICIES } = require('../constants/policy'); // 규모별 정책 상수 (S, M, L)

/**
 * [전체 이벤트 재고 Redis Warm-up]
 * 티켓 오픈 시 DB 부하를 줄이기 위해 승인된 공연의 재고를 Redis에 미리 로드함
 */
exports.warmupAllEventsToRedis = async () => {
    try {
        // 데이터 정합성을 위해 Redis 초기화 후 재등록
        await redis.flushAll(); 
        console.log("🧹 [Redis] 기존 재고 데이터를 모두 삭제했습니다.");

        // 승인된 공연의 잔여석 정보만 최소한으로 조회
        const events = await prisma.events.findMany({
            where: { approval_status: 'CONFIRMED' },
            select: { event_id: true, available_seats: true }
        });

        // Redis에 'event:stock:ID' 키로 재고 저장
        for (const event of events) {
            const stockKey = `event:stock:${event.event_id}`;
            await redis.set(stockKey, event.available_seats);
        }

        console.log(`🚀 [Warm-up] ${events.length}개 이벤트 재고 동기화 완료!`);
    } catch (err) {
        console.error("❌ Warm-up 중 오류 발생:", err);
        throw err; 
    }
};

/**
 * [카카오 API 좌표 변환]
 * -------------------------------------------------------------------------
 * 목적: 텍스트 주소를 위도(Lat)와 경도(Lng) 좌표로 변환함.
 * 특징: .env 설정 시 발생할 수 있는 키값의 공백/줄바꿈 문자를 정규식으로 원천 차단함.
 * -------------------------------------------------------------------------
 */
exports.getCoordinates = async (address) => {
    try {
        const url = process.env.KAKAO_API_URL;
        const rawKey = process.env.KAKAO_REST_API_KEY || "";
        
        // [방어 코드] API 키에 포함될 수 있는 모든 공백, 탭, 줄바꿈(\n, \r)을 제거하여 인증 오류 방지
        const cleanKey = rawKey.replace(/[\s\t\n\r]/g, "").trim(); 

        // [유효성 검증] API 키가 비어있을 경우 호출을 중단하고 에러 로그 출력
        if (!cleanKey) {
            console.error("❌ KAKAO_REST_API_KEY 누락: .env 파일을 확인하세요.");
            return null;
        }

        /**
         * [API 호출] Axios를 사용하여 카카오 로컬 API 실행
         * Authorization 헤더 형식: KakaoAK {REST_API_KEY}
         */
        const response = await axios.get(url, {
            params: { query: address },
            headers: { 'Authorization': `KakaoAK ${cleanKey}` }
        });

        /**
         * [데이터 파싱] 
         * 검색 결과(documents)가 존재하면 첫 번째 결과의 좌표를 반환함.
         * x: 경도(Longitude), y: 위도(Latitude) -> 우리 시스템 형식으로 변환
         */
        if (response.data.documents && response.data.documents.length > 0) {
            const { x, y } = response.data.documents[0];
            return { lat: parseFloat(y), lng: parseFloat(x) };
        }

        // 검색 결과가 없는 경우
        return null;

    } catch (error) {
        // [에러 핸들링] 네트워크 문제나 잘못된 API 키 입력 시 예외 처리
        console.error("❌ 카카오 API 호출 실패:", error.message);
        throw error;
    }
};

/**
 * [관리자용: Redis 단일 재고 세팅]
 */
exports.initEventStock = async (eventId, stockCount) => {
    const key = `event:stock:${eventId}`;
    await redis.set(key, stockCount);
    return { event_id: eventId, stock_count: stockCount };
};

/**
 * [관리자 응답 처리 서비스]
 * 관리자의 승인/거절 신호를 처리하며, 승인 시 규모별 정산 정책을 자동 생성함
 */
exports.processAdminResponse = async (response) => {
    const incomingId = response.eventId || response.approvalId;
    const { status, admin_id, rejectionReason } = response;

    if (!incomingId) throw new Error("ID가 전달되지 않았음");

    // 1. 승인 요청 기록이 존재하는지 먼저 확인
    const approvalReq = await eventRepository.findApprovalById(incomingId);
    if (!approvalReq) throw new Error(`승인 요청건을 찾을 수 없음: ${incomingId}`);

    const actualEventId = approvalReq.event_id;

    // 2. 트랜잭션 처리: 공연 상태 변경과 수수료 정책 저장을 일관되게 처리
    return await prisma.$transaction(async (tx) => {
        if (status === 'CONFIRMED') {
            // 공연 상태를 'CONFIRMED'로 업데이트하고 업데이트된 정보를 가져옴
            const updatedEvent = await eventRepository.confirmEvent(tx, actualEventId, admin_id);

            // [자동화 로직] 좌석 수 기준(total_capacity)으로 정책(S/M/L) 자동 결정
            const policy = SCALE_POLICIES.find(p => updatedEvent.total_capacity >= p.min);

            // 결정된 정책(등급, 정산주기, 수수료율)을 정책 테이블에 저장
            await tx.event_fee_policies.create({
                data: {
                    event_id: actualEventId,
                    scale_group: policy.group,
                    settlement_type: policy.type,
                    sales_commission_rate: policy.rate
                }
            });

            console.log(`✨ [자동화] 공연 ${actualEventId}: ${policy.group}그룹 정책 수립`);
            return updatedEvent;

        } else if (status === 'FAILED') {
            // 거절 처리 (rejectionReason 포함)
            return await eventRepository.rejectEvent(tx, actualEventId, admin_id, rejectionReason);
        }
    });
};