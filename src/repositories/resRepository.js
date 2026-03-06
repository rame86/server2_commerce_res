// src/repositories/resRepository.js

/**
 * FanVerse - Reservation Repository Layer
 * 담당: Prisma를 이용한 PostgreSQL(Server 1) 데이터 제어
 */

const { PrismaClient } = require('@prisma/client');
// process.env.DATABASE_URL이 제대로 들어오는지 확인하고 Prisma에 전달
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL, 
    },
  },
});

// [디버깅 로그] 서버 켤 때 주소가 localhost인지 34.158...인지 바로 확인 가능
console.log("📡 현재 연결 시도 중인 DB 주소:", process.env.DATABASE_URL?.split('@')[1] || "주소 없음");

/**
 * [추가: Redis Warm-up용 DB 재고 조회]
 * Prisma는 pool.query 대신 모델 메서드를 사용해
 */
exports.getEventStock = async (eventId) => {
    try {
        // prisma.event -> prisma.events로 수정
        const targetEvent = await prisma.events.findUnique({
            where: { event_id: parseInt(eventId, 10) },
            select: { available_seats: true }
        });

        // 핵심 주석: Prisma events 모델을 통해 재고 조회 수행
        return targetEvent ? targetEvent.available_seats : 0;
    } catch (err) {
        console.error("❌ [getEventStock Error]:", err.message);
        throw err;
    }
};


/**
 * [특정 공연 조회]
 * 서비스 계층에서 가격 계산 및 포인트 검증을 위해 호출함
 */
exports.findEventById = async (eventId) => {
    // 특정 ID에 해당하는 공연 정보만 쏙 뽑아옴
    return await prisma.events.findUnique({
        where: { event_id: parseInt(eventId, 10) }
    });
};

/**
 * [공연 목록 조회]
 * 일반적인 단순 조회는 Pool에서 비어있는 클라이언트를 자동으로 하나 써서 결과를 가져옴
 * **"요청이 올 때마다 DB에서 꺼내오는 방식"**
 */
exports.findAllEvents = async () => {
    try {
        return await prisma.events.findMany({ 
            include: {
                event_locations: true,
                event_images: true // 사진 정보도 한꺼번에 가져오기!
            },
            orderBy: { event_date: 'asc' }
        });
    } catch (err) {
        console.error("❌ Repository findAllEvents 에러:", err);
        throw err;
    }
};

/**
 * [예약 생성 트랜잭션]
 * 선착순 예약의 핵심인 '조회 후 업데이트' 과정을 하나의 작업 단위로 묶음
 * DB에 직접 접근하여 예약을 생성하는 Repository (Java의 Mapper 역할)
 */
exports.createReservationWithTransaction = async (data) => {
    return await prisma.$transaction(async (tx) => {
        // 1. 재고 확인 및 행 잠금 (Prisma는 기본적으로 업데이트 시 락을 활용함)
        const event = await tx.events.findUnique({
            where: { event_id: data.event_id }
        });

        if (!event) throw new Error("존재하지 않는 공연입니다.");
        if (event.available_seats < data.ticket_count) {
            throw new Error("잔여석이 부족하여 예매할 수 없습니다.");
        }

        // 2. 재고 차감 (Update)
        await tx.events.update({
            where: { event_id: data.event_id },
            data: {
                available_seats: {
                    decrement: data.ticket_count // 원자적 차감 수행
                }
            }
        });

        // 3. 예약 데이터 삽입 (Insert)
        // Prisma의 트랜잭션(tx)을 사용하여 reservations 테이블에 데이터 삽입
        const reservation = await tx.reservations.create({
            data: {
                event_id: data.event_id,
                member_id: data.member_id,
                ticket_count: data.ticket_count,
                total_price: data.total_price,
                ticket_code: data.ticket_code,
                status: 'PENDING' // DB에 들어갈 때 결정되는 고유 상태값// 예약 확정 상태로 저장
            }
        });

        // 핵심 주석: Prisma 트랜잭션 성공 시 자동 COMMIT, 에러 시 자동 ROLLBACK
        return reservation;
    });
};


// [보상 트랜잭션] 결제 실패 시 예약 취소 및 DB 재고 원복
exports.cancelReservationAndRestoreStock = async (ticket_code, event_id, ticket_count) => {
    return await prisma.$transaction(async (tx) => {
        // 1. 현재 예약 상태 확인 (중복 취소 방지)
        const reservation = await tx.reservations.findFirst({
            where: { ticket_code: ticket_code }
        });

        // [방어 코드] 예약 데이터가 없으면 이후 로직(update)을 타지 않게 막음
        if (!reservation) {
            console.log(`⚠️ [Skip] 이미 취소되었거나 없는 예약입니다: ${ticket_code}`);
            return null; 
        }

        // 2. 예약 상태 변경
        const updatedRes = await tx.reservations.update({
            // ticket_code 대신 이미 DB에서 조회해온 진짜 ID를 사용
            where: { reservation_id: reservation.reservation_id },
            data: { status: 'FAILED' }
        });

        // 3. DB 재고 원복
        await tx.events.update({
            where: { event_id: event_id },
            data: { available_seats: { increment: ticket_count } }
        });

        // 핵심 주석: 상태 체크 후 취소 처리함으로써 재고 중복 복구 방지
        return updatedRes;
    });
};

// 1. [조회] 티켓 존재 여부 및 정보 확인 (수민이가 짠 코드)
exports.findReservationByCode = async (ticket_code) => {
    return await prisma.reservations.findUnique({
        where: { ticket_code: ticket_code }
    });
};

// 2. [수정] 환불 확정 및 좌석 복구 (트랜잭션)
exports.completeRefund = async (ticket_code, event_id, ticket_count) => {
    return await prisma.$transaction(async (tx) => {
        // [Step 1] 예약 상태 변경 (CONFIRMED -> REFUNDED 또는 CANCELED)
        const updatedRes = await tx.reservations.update({
            where: { ticket_code: ticket_code },
            data: { status: 'REFUNDED' } // 상태를 환불완료로 변경
        });

        // [Step 2] DB 좌석 수 복구 (+ 수량만큼 늘려줌)
        await tx.events.update({
            where: { event_id: event_id },
            data: { 
                available_seats: { 
                    increment: ticket_count 
                } 
            }
        });

        return updatedRes;
    });
};