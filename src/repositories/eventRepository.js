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
 * [Redis Warm-up용 DB 재고 조회]
 */
exports.getEventStock = async (eventId) => {
    try {
        /**
         * [특정 필드 추출 쿼리]
         * findUnique를 사용하여 특정 공연을 식별하고, 'select' 옵션을 통해 
         * 'available_seats(잔여 좌석)' 정보만 네트워크를 통해 가져옴 (최적화).
         */
        const targetEvent = await prisma.events.findUnique({
            where: { event_id: parseInt(eventId, 10) },
            select: { available_seats: true }
        });

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
    return await prisma.events.findUnique({
        where: { 
            event_id: parseInt(eventId, 10),
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
         * 승인 완료된 공연 목록을 가져오며, 장소와 이미지 데이터를 JOIN하여 한 번에 가져옴.
         */
        return await prisma.events.findMany({ 
            where: { approval_status: 'CONFIRMED' },
            include: {
                event_locations: true,
                event_images: true 
            },
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
exports.findApprovalById = async (eventId) => {
    if (!eventId) {
        throw new Error("eventId(approvalId)가 전달되지 않았어!");
    }

    /**
     * [승인 요청 데이터 조회]
     * Spring에서 관리자 승인 시 보낸 ID를 기준으로 event_approvals 테이블에서 매칭되는 정보를 찾음.
     */
    return await prisma.event_approvals.findFirst({
        where: {
            event_id: parseInt(eventId, 10)
        }
    });
};

/**
 * [공연 승인 및 정보 반환]
 */
exports.confirmEvent = async (tx, eventId, adminId) => {
    /**
     * [승인 상태 업데이트]
     * 1. event_approvals 테이블의 상태를 'CONFIRMED'로 변경하고 처리 시각과 관리자 ID 기록.
     * 2. events 테이블의 상태를 'CONFIRMED'로 변경.
     * 3. 서비스 레이어에서 자동 정책 계산(total_capacity 확인)을 할 수 있도록 업데이트된 공연 객체를 리턴함.
     */
    await tx.event_approvals.updateMany({
        where: { event_id: Number(eventId) },
        data: { 
            status: 'CONFIRMED', 
            admin_id: adminId ? BigInt(adminId) : null,
            processed_at: new Date()
        }
    });

    return await tx.events.update({
        where: { event_id: Number(eventId) },
        data: { approval_status: 'CONFIRMED' }
    });
};

/**
 * [정산 정책 데이터 생성]
 */
exports.createFeePolicy = async (tx, data) => {
    /**
     * [정책 자동 기록]
     * 서비스 레이어에서 결정된 규모 등급(S/M/L), 정산 타입(NOW/DAY/END), 수수료율(5/8/12)을
     * event_fee_policies 테이블에 최종 저장함.
     */
    return await tx.event_fee_policies.create({
        data: {
            event_id: data.event_id,
            scale_group: data.scale_group,
            settlement_type: data.settlement_type,
            sales_commission_rate: data.sales_commission_rate
        }
    });
};

/**
 * [공연 반려 처리]
 */
exports.rejectEvent = async (tx, eventId, adminId, reason) => {
    /**
     * [반려 상태 업데이트]
     * 1. event_approvals 테이블에 반려 사유와 상태 기록.
     * 2. events 테이블의 상태를 'FAILED'로 변경하여 사용자에게 노출되지 않도록 함.
     */
    await tx.event_approvals.updateMany({
        where: { event_id: Number(eventId) },
        data: { 
            status: 'FAILED', 
            rejection_reason: reason,
            admin_id: adminId ? BigInt(adminId) : null,
            processed_at: new Date()
        }
    });

    return await tx.events.update({
        where: { event_id: Number(eventId) },
        data: { approval_status: 'FAILED' }
    });
};

/**
 * [정산 정책 조회]
 * 예약 및 환불 시 지갑 서버로 넘겨줄 아티스트 수수료율(%)과 정산 방식을 조회함.
 */
exports.getFeePolicy = async (eventId) => {
    return await prisma.event_fee_policies.findUnique({
        where: { event_id: parseInt(eventId, 10) }
    });
};