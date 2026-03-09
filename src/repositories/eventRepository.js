// src/repositories/eventRepository.js

/**
 * FanVerse - Event Repository Layer
 * 담당: Prisma를 이용한 공연 관련 PostgreSQL(Server 1) 데이터 제어
 */

const { PrismaClient } = require('@prisma/client');

/**
 * [Prisma 인스턴스 초기화]
 * 환경 변수(DATABASE_URL)를 명시적으로 데이터소스에 주입하여
 * PostgreSQL 서버와의 연결 풀(Pool)을 생성함.
 */
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL, 
    },
  },
});

/**
 * [추가: Redis Warm-up용 DB 재고 조회]
 */
exports.getEventStock = async (eventId) => {
    try {
        /**
         * [특정 필드 추출 쿼리]
         * findUnique를 사용하여 특정 공연을 식별하고, 'select' 옵션을 통해 
         * 불필요한 필드를 제외한 'available_seats(잔여 좌석)' 정보만 네트워크를 통해 가져옴 (최적화).
         */
        const targetEvent = await prisma.events.findUnique({
            where: { event_id: parseInt(eventId, 10) },
            select: { available_seats: true }
        });

        // 핵심 주석: Prisma events 모델을 통해 재고 조회 수행
        /**
         * [결과 반환 및 가공]
         * 조회 결과가 있으면 좌석 수를 반환하고, 공연 자체가 존재하지 않으면 안전하게 0을 반환함.
         */
        return targetEvent ? targetEvent.available_seats : 0;
    } catch (err) {
        console.error("❌ [getEventStock Error]:", err.message);
        throw err;
    }
};

/**
 * [특정 공연 조회]
 */
exports.findEventById = async (eventId) => {
    /**
     * [단일 엔티티 조회]
     * 서비스 계층에서 티켓 가격 계산이나 유효성 검증을 할 때 필요한 모든 공연 정보를
     * PK(Primary Key)인 event_id를 기준으로 정확히 한 건만 추출함.
     */
    return await prisma.events.findUnique({
        where: { 
            event_id: parseInt(eventId, 10),
            // 🌟 상세 조회 시에도 승인된 건인지 확인하고 싶다면 아래 주석 해제 (단, findFirst 사용 권장)
            approval_status: 'CONFIRMED' 
        }
    });
};

/**
 * [공연 목록 조회]
 */
exports.findAllEvents = async () => {
    try {
        /**
         * [관계형 데이터 통합 조회 - Eager Loading]
         * findMany를 통해 전체 공연 목록을 가져오되, 'include' 옵션을 사용하여 
         * 자식 테이블인 'event_locations(장소)'와 'event_images(이미지)' 데이터를 
         * 한 번의 쿼리로 묶어 가져옴 (JOIN 수행).
         */
        return await prisma.events.findMany({ 
            // 🌟 [필터] 승인 완료(CONFIRMED)된 공연만 사용자에게 보여줌
            where: {
                approval_status: 'CONFIRMED'
            },
            include: {
                event_locations: true,
                event_images: true // 사진 정보도 한꺼번에 가져오기!
            },
            /**
             * [정렬 조건 적용]
             * 공연 날짜(event_date)를 기준으로 오름차순(asc) 정렬하여 
             * 사용자가 날짜순으로 공연을 볼 수 있게 함.
             */
            orderBy: { event_date: 'asc' }
        });
    } catch (err) {
        console.error("❌ Repository findAllEvents 에러:", err);
        throw err;
    }
};


/**
 * [승인 대기열 조회]
 */
exports.findApprovalById = async (approvalId) => {
    return await prisma.event_approvals.findUnique({
        where: { approval_id: Number(approvalId) }
    });
};

/**
 * [승인 데이터 최종 확정 저장]
 * Service에서 넘겨준 트랜잭션(tx) 객체를 그대로 사용해서 원자성을 보장함.
 */
exports.confirmEvent = async (tx, eventData, locationData, approvalId, adminId) => {
    // 1. 실제 공연 생성
    const newEvent = await tx.events.create({ data: eventData });

    // 2. 위치 정보 생성
    await tx.event_locations.create({
        data: { ...locationData, event_id: newEvent.event_id }
    });

    // 3. 신청 대기열 상태 업데이트
    await tx.event_approvals.update({
        where: { approval_id: Number(approvalId) },
        data: { 
            status: 'CONFIRMED', 
            event_id: newEvent.event_id,
            admin_id: adminId ? BigInt(adminId) : null,
            processed_at: new Date()
        }
    });

    return newEvent;
};

/**
 * [반려 상태 업데이트]
 */
exports.updateApprovalFailed = async (approvalId, adminId, reason) => {
    return await prisma.event_approvals.update({
        where: { approval_id: Number(approvalId) },
        data: { 
            status: 'FAILED', 
            rejection_reason: reason,
            admin_id: adminId ? BigInt(adminId) : null,
            processed_at: new Date()
        }
    });
};
