require('dotenv').config();
const amqp = require('amqplib');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const redis = require('../../config/redisClient');

/**
 * [Status Consumer]
 * 역할: Spring(결제 마이크로서비스)으로부터 전달받은 결제/환불 최종 결과를 처리함.
 * 핵심: 분산 환경에서 DB 상태(Prisma)와 실시간 재고(Redis)의 일관성을 맞추는 최종 단계.
 */
async function startStatusUpdateConsumer() {
    // 1. RabbitMQ 연결 설정 (환경변수 기반)
    const mqUser = process.env.RABBITMQ_USER || 'guest';
    const mqPass = process.env.RABBITMQ_PASSWORD || 'guest';
    const mqHost = process.env.RABBITMQ_HOST || 'localhost';
    const rabbitUrl = `amqp://${mqUser}:${mqPass}@${mqHost}:5672`;

    try {
        const connection = await amqp.connect(rabbitUrl);
        const channel = await connection.createChannel();

        // 2. 수신용 큐 선언 (Spring에서 보낸 메시지가 쌓이는 곳)
        // durable: true -> 메시지 브로커가 재시작되어도 큐 데이터 유지
        const UPDATE_QUEUE = "res.status.update.queue";
        await channel.assertQueue(UPDATE_QUEUE, { durable: true });

        console.log(`📩 [Status Consumer] 통합 결과 수신 대기 중 (결제/환불)...`);

        // 3. 메시지 구독(Consume) 시작
        channel.consume(UPDATE_QUEUE, async (msg) => {
            if (msg !== null) {
                // RabbitMQ에서 받은 버퍼 데이터를 JSON 객체로 파싱
                const response = JSON.parse(msg.content.toString());
                
                console.log("-----------------------------------------");
                console.log("📩 [수신 데이터 확인]:", response); 
                console.log("-----------------------------------------");

                // orderId(티켓코드), status(처리결과), type(결제/환불 구분) 추출
                const { orderId, status, type } = response; 

                try {
                    /**
                     * [필터링] Spring에서 보낸 상태값이 성공 신호인지 확인
                     * COMPLETE/SUCCESS: 일반 결제 성공
                     * REFUNDED: 환불 처리 완료
                     */
                    if (status === 'COMPLETE' || status === 'SUCCESS' || status === 'REFUNDED') {
                        
                        /**
                         * 1️⃣ [환불 확정 로직]
                         * 조건: 메시지 타입이 REFUND이거나 상태값이 REFUNDED일 때
                         */
                        if (type === 'REFUND' || status === 'REFUNDED') {
                            console.log(`♻️ [환불 확정] DB 업데이트 시작: ${orderId}`);

                            // 현재 예약 정보 조회 (재고 복구에 필요한 event_id와 수량 파악용)
                            const reservation = await prisma.reservations.findUnique({
                                where: { ticket_code: orderId }
                            });

                            // 멱등성 보장: 예약 데이터가 존재하고 아직 REFUNDED 상태가 아닐 때만 로직 실행
                            if (reservation && reservation.status !== 'REFUNDED') {
                                
                                // [Atomic Transaction] 예약 상태 변경과 DB 재고 복구는 반드시 동시에 성공해야 함
                                await prisma.$transaction(async (tx) => {
                                    // (1) 예약 테이블 상태를 'REFUNDED'로 업데이트
                                    await tx.reservations.update({
                                        where: { ticket_code: orderId },
                                        data: { status: 'REFUNDED' }
                                    });
                                    // (2) 공연 테이블의 가용 좌석 수(available_seats) 원복
                                    await tx.events.update({
                                        where: { event_id: reservation.event_id },
                                        data: { available_seats: { increment: reservation.ticket_count } }
                                    });
                                });

                                // [Redis Sync] 사용자가 직접 마주하는 실시간 재고도 즉시 증가시킴
                                // DB 트랜잭션 성공 후 실행하여 데이터 정합성 유지
                                const stockKey = `event:stock:${reservation.event_id}`;
                                await redis.incrBy(stockKey, reservation.ticket_count);
                                
                                console.log(`🚀 [복구 완료] 주문 ${orderId} -> REFUNDED 변경 및 재고 환원 완료`);
                            }
                        } 
                        /**
                         * 2️⃣ [결제 완료 로직]
                         * 조건: 환불이 아닌 일반 결제 성공 케이스
                         */
                        else {
                            await prisma.reservations.update({
                                where: { ticket_code: orderId },
                                data: { status: 'CONFIRMED' }
                            });
                            console.log(`✅ [결제 완료] 주문 ${orderId} -> CONFIRMED 변경`);
                        }
                    }
                    
                    // 4. 메시지 확인 응답(Acknowledge)
                    // 이 코드가 실행되어야 RabbitMQ에서 해당 메시지가 완전히 삭제됨
                    channel.ack(msg);

                } catch (error) {
                    console.error("❌ 컨슈머 내부 처리 에러:", error.message);
                    // nack: 처리 실패 시 메시지를 큐에서 제거하되 재시도는 하지 않음 (Dead Letter Queue 고려 가능)
                    channel.nack(msg, false, false);
                }
            }
        });

    } catch (error) {
        console.error("❌ RabbitMQ 연결 또는 채널 생성 에러:", error.message);
    }
}

// 5. app.js에서 초기화 시 호출할 수 있도록 함수 수출
module.exports = startStatusUpdateConsumer;