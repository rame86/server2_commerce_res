// src/repositories/resRepository.js

/**
 * FanVerse - Reservation Repository Layer
 * 담당: Prisma를 이용한 예약 관련 PostgreSQL(Server 1) 데이터 제어
 */

const { PrismaClient } = require('@prisma/client');

/**
 * [Prisma 인스턴스 초기화]
 * 데이터베이스 연결 설정 및 환경 변수를 로드하여 DB 서버와의 통신 준비를 마침
 */
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL, 
    },
  },
});

// [디버깅 로그] 서버 구동 시 현재 연결된 DB의 호스트 주소를 노출하여 연결 상태를 즉시 확인함
console.log("📡 현재 연결 시도 중인 DB 주소:", process.env.DATABASE_URL?.split('@')[1] || "주소 없음");

/**
 * [예약 생성 트랜잭션]
 * 선착순 예약의 핵심인 '조회 후 업데이트' 과정을 하나의 작업 단위로 묶음
 */
exports.createReservationWithTransaction = async (data) => {
    /**
     * [트랜잭션 격리]
     * $transaction을 사용하여 내부 로직 중 하나라도 실패하면 전체 과정을 롤백함
     */
    return await prisma.$transaction(async (tx) => {
        
        // 1. [재고 확인 및 행 잠금] 
        // findUnique를 통해 공연 데이터를 조회함. 트랜잭션 내에서 조회하므로 데이터 정합성을 확보함.
        const event = await tx.events.findUnique({
            where: { event_id: data.event_id }
        });

        // [방어 로직] 존재하지 않는 공연이거나, 실시간 잔여석이 구매 수량보다 적으면 즉시 에러를 던져 중단함
        if (!event) throw new Error("존재하지 않는 공연입니다.");
        if (event.available_seats < data.ticket_count) {
            throw new Error("잔여석이 부족하여 예매할 수 없습니다.");
        }

        // 2. [재고 차감 (Update)]
        // DB의 원자적 연산(decrement)을 사용하여 available_seats 수치를 구매 수량만큼 줄임
        await tx.events.update({
            where: { event_id: data.event_id },
            data: {
                available_seats: {
                    decrement: data.ticket_count 
                }
            }
        });

        // 3. [예약 데이터 삽입 (Insert)]
        // 최종적으로 reservations 테이블에 예약 내역을 생성함. 초기 상태는 'PENDING'으로 설정함.
        const reservation = await tx.reservations.create({
            data: {
                event_id: data.event_id,
                member_id: data.member_id,
                ticket_count: data.ticket_count,
                total_price: data.total_price,
                ticket_code: data.ticket_code,
                status: 'PENDING' 
            }
        });

        // 핵심 주석: Prisma 트랜잭션 성공 시 자동 COMMIT, 에러 시 자동 ROLLBACK
        return reservation;
    });
};

/**
 * [보상 트랜잭션] 결제 실패 시 예약 취소 및 DB 재고 원복
 */
exports.cancelReservationAndRestoreStock = async (ticket_code, event_id, ticket_count) => {
    /**
     * [복구 트랜잭션] 
     * 데이터 일관성을 위해 상태 변경과 재고 복구를 하나의 단위로 실행함
     */
    return await prisma.$transaction(async (tx) => {
        
        // 1. [현재 예약 상태 확인]
        // findFirst를 통해 취소하려는 티켓의 존재 여부를 먼저 파악함
        const reservation = await tx.reservations.findFirst({
            where: { ticket_code: ticket_code }
        });

        // [중복 취소 방지] 이미 취소되었거나 데이터가 없다면 무의미한 업데이트를 하지 않고 스킵함
        if (!reservation) {
            console.log(`⚠️ [Skip] 이미 취소되었거나 없는 예약입니다: ${ticket_code}`);
            return null; 
        }

        // 2. [예약 상태 변경]
        // 예약 내역의 PK(ID)를 기준으로 상태를 'FAILED'로 업데이트함
        const updatedRes = await tx.reservations.update({
            where: { reservation_id: reservation.reservation_id },
            data: { status: 'FAILED' }
        });

        // 3. [DB 재고 원복]
        // 취소된 티켓 수량만큼 events 테이블의 available_seats를 다시 증가(increment)시킴
        await tx.events.update({
            where: { event_id: event_id },
            data: { available_seats: { increment: ticket_count } }
        });

        // 핵심 주석: 상태 체크 후 취소 처리함으로써 재고 중복 복구 방지
        return updatedRes;
    });
};

/**
 * 1. [조회] 티켓 존재 여부 및 정보 확인
 */
exports.findReservationByCode = async (ticket_code) => {
    /**
     * [단일 건 조회]
     * 고유 키인 ticket_code를 사용하여 특정 예약 건의 모든 정보를 불러옴
     */
    return await prisma.reservations.findUnique({
        where: { ticket_code: ticket_code }
    });
};

/**
 * 2. [수정] 환불 확정 및 좌석 복구 (트랜잭션)
 */
exports.completeRefund = async (ticket_code, event_id, ticket_count) => {
    /**
     * [환불 트랜잭션]
     * 결제 취소가 완료된 후 DB 상태를 'REFUNDED'로 바꾸고 좌석을 다시 시장에 내놓는 과정임
     */
    return await prisma.$transaction(async (tx) => {
        
        // [Step 1] 예약 상태 변경 
        // 특정 티켓의 상태를 환불 완료(REFUNDED)로 변경함
        const updatedRes = await tx.reservations.update({
            where: { ticket_code: ticket_code },
            data: { status: 'REFUNDED' } 
        });

        // [Step 2] DB 좌석 수 복구 
        // 해당 공연의 재고 수량을 환불된 수량만큼 다시 늘려줌
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