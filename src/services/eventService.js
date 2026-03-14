const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const redis = require('../config/redisClient');
const eventRepository = require('../repositories/eventRepository');
const { SCALE_POLICIES } = require('../constants/policy'); // 규모별 정책 상수 (S, M, L)

/**
 * [공연 신청 및 승인 요청] - POST /events 대응
 * -------------------------------------------------------------------------
 * 에러 해결: member_id가 undefined일 때 BigInt 변환으로 터지는 문제 방어
 * -------------------------------------------------------------------------
 */
exports.requestEventApproval = async (eventData) => {
    // 1. 주소를 좌표로 변환
    const coords = await this.getCoordinates(eventData.address);
    if (!coords) {
        throw new Error("주소를 좌표로 변환할 수 없습니다. 주소를 확인해주세요.");
    }

    // 2. 사용자 ID 추출 및 검증
    const memberId = eventData.member_id || eventData.memberId;
    if (memberId === undefined || memberId === null) {
        throw new Error("신청 실패: 사용자 ID(member_id)가 누락되었습니다.");
    }

    /**
     * 🌟 3. [추가] 이미지 데이터 정제
     * 클라이언트가 보낸 images가 배열인지 확인하고, 
     * 레포지토리가 원하는 { url, type } 형태로 가공해서 넘김
     */
    const images = Array.isArray(eventData.images) 
        ? eventData.images.map(img => ({
            url: img.image_url || img.url, 
            type: img.image_type || img.type || 'POSTER'
        })) 
        : [];

    // 4. 모든 정제된 데이터를 레포지토리로 전달
    return await eventRepository.createEventRequest({
        ...eventData,
        images: images,      // 🌟 가공된 이미지 배열 추가
        member_id: memberId,
        lat: coords.lat,
        lng: coords.lng
    });
};

/**
 * [전체 이벤트 재고 Redis Warm-up - 필드 최적화]
 * 티켓 오픈 시 DB 부하를 줄이기 위해 승인된 공연의 재고를 Redis에 미리 로드함
 */
exports.warmupAllEventsToRedis = async () => {
    try {
        await redis.flushAll(); 
        
        // 🌟 is_standing 정보를 함께 가져와서 나중에 좌석 선택 로직에서 활용 가능하게 함
        const events = await prisma.events.findMany({
            where: { approval_status: 'CONFIRMED' },
            select: { event_id: true, available_seats: true, is_standing: true }
        });

        for (const event of events) {
            const stockKey = `event:stock:${event.event_id}`;
            const infoKey = `event:info:${event.event_id}`;
            
            await redis.set(stockKey, event.available_seats);
            // 🌟 부가 정보(스탠딩 여부 등)도 캐싱해두면 예매 시 속도가 비약적으로 빨라짐
            await redis.set(infoKey, JSON.stringify({ isStanding: event.is_standing }));
        }

        console.log(`🚀 [Warm-up] ${events.length}개 이벤트 데이터 Redis 로드 완료!`);
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
 * [관리자 응답 처리 서비스 - 1번 과제 최종 반영]
 * -------------------------------------------------------------------------
 * 역할: 관리자의 승인/거절 신호를 처리하고, 승인 시 스냅샷 데이터 확정 및 정책 생성
 * 해결: Java(Long) -> Node(BigInt) 에러 방어 및 신규 필드 업데이트 추가
 * -------------------------------------------------------------------------
 */
exports.processAdminResponse = async (response) => {
    console.log("📥 [Admin Response Data]:", response);

    // 1. 관리자가 보낸 건 '공연 ID'임 (예: 5)
    const incomingEventId = response.eventId || response.adminEventId; 
    const admin_id = response.admin_id || response.adminId; 
    const { status, rejectionReason } = response;

    if (!incomingEventId) throw new Error("공연 ID(eventId)가 전달되지 않았음");

    // 2. 🔍 역추적: event_id가 5번이면서 대기 중인 승인 요청서를 DB에서 찾음
    const approvalReq = await prisma.event_approvals.findFirst({
        where: { 
            event_id: Number(incomingEventId),
            status: 'PENDING' 
        }
    });

    if (!approvalReq) throw new Error(`공연 ID ${incomingEventId}에 해당하는 대기 건이 없음`);

    // 🌟 진짜 필요한 ID들을 여기서 확정
    const realApprovalId = approvalReq.approval_id; // 승인 테이블의 PK
    const actualEventId = approvalReq.event_id;     // 공연 테이블의 PK
    const snapshot = approvalReq.event_snapshot; 

    const result = await prisma.$transaction(async (tx) => {
        if (status === 'CONFIRMED') {
            // [수정 1] 이제 진짜 PK(realApprovalId)로 승인 테이블 업데이트
            await tx.event_approvals.update({
                where: { approval_id: realApprovalId },
                data: { 
                    status: 'CONFIRMED', 
                    admin_id: admin_id ? BigInt(admin_id) : null,
                    processed_at: new Date() 
                }
            });

            // [수정 2] 공연 테이블 업데이트
            const updatedEvent = await tx.events.update({
                where: { event_id: Number(actualEventId) }, 
                data: {
                    approval_status: 'CONFIRMED',
                    approval_id: realApprovalId, // 외래키로 연결
                    age_limit: snapshot.age_limit || 0,
                    running_time: snapshot.running_time || 0,
                    is_standing: snapshot.is_standing || false,
                    seat_map_config: snapshot.seat_map_config || null,
                    updated_at: new Date()
                }
            });

            // [자동화] 정책 수립
            const policy = SCALE_POLICIES.find(p => updatedEvent.total_capacity >= p.min);
            await tx.event_fee_policies.create({
                data: {
                    event_id: actualEventId,
                    scale_group: policy.group,
                    settlement_type: policy.type,
                    sales_commission_rate: policy.rate
                }
            });

            console.log(`✨ [자동화 완료] 공연 ${actualEventId}: 상세 데이터 확정 및 ${policy.group}그룹 정책 수립`);
            return updatedEvent;

        } else if (status === 'FAILED') {
            return await eventRepository.rejectEvent(tx, actualEventId, admin_id, rejectionReason);
        }
    });

    // 3. Redis 동기화 (기존 동일)
    if (status === 'CONFIRMED' && result) {
        const stockKey = `event:stock:${actualEventId}`;
        const infoKey = `event:info:${actualEventId}`;
        await redis.set(stockKey, result.available_seats);
        await redis.set(infoKey, JSON.stringify({ isStanding: result.is_standing }));
        console.log(`🚀 [Redis] 공연 ${actualEventId} 잔여석 실시간 세팅 완료!`);
    }

    return result;
};