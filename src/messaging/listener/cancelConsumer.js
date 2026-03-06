//src/messaging/listener/cancelConsumer.js
const amqp = require('amqplib');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const redis = require('../../config/redisClient');
const { QUEUES } = require('../../config/rabbitMQ');

/**
 * [비상 취소 감시 컨슈머]
 * 결제 서비스 등 외부 서버에서 '결제 실패'나 '주문 취소' 이벤트가 발생했을 때
 * 예약 서버의 데이터를 이전 상태로 복구(Rollback)하는 역할을 수행함.
 */
async function startCancelConsumer() {
    // [환경 변수 로드] RabbitMQ 연결을 위한 주소를 환경 변수 기반으로 구성함
    const rabbitUrl = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}@${process.env.RABBITMQ_HOST}:5672`;

    try {
        // [MQ 연결 및 채널 생성] RabbitMQ 서버와 통신하기 위한 커넥션을 맺음
        const connection = await amqp.connect(rabbitUrl);
        const channel = await connection.createChannel();

        // 핵심 주석: 중앙 설정파일의 점(.) 표기법 큐 이름 사용 (중앙 집중식 큐 관리)
        // [큐 선언] 취소 메시지가 쌓일 큐가 존재하는지 확인하고, 서버 재시작 시에도 메시지가 유지되도록 durable 옵션을 줌
        await channel.assertQueue(QUEUES.CANCEL, { durable: true });

        console.log(`🛡️ [Cancel Consumer] 비상 취소 감시 중: ${QUEUES.CANCEL}`);

        /**
         * [메시지 구독 시작]
         * 취소 큐에 메시지가 들어오면 비동기적으로 이를 감지하여 처리함
         */
        channel.consume(QUEUES.CANCEL, async (msg) => {
            // [방어 코드] 빈 메시지가 들어올 경우 로직을 수행하지 않음
            if (!msg) return;

            // [데이터 파싱] 버퍼 형태의 메시지를 JSON 객체로 변환하여 주문번호와 사유를 추출함
            const { orderId, reason } = JSON.parse(msg.content.toString());
            console.log(`⚠️ [취소 감지] 주문번호: ${orderId}, 사유: ${reason}`);

            try {
                // [1] 해당 주문 데이터 찾기: 취소하려는 주문(티켓 코드)이 DB에 실재하는지 조회함
                const reservation = await prisma.reservations.findUnique({
                    where: { ticket_code: orderId }
                });

                /**
                 * [2] 보상 트랜잭션(Rollback) 실행 조건 확인
                 * 예약 내역이 존재하고, 아직 'FAILED' 상태로 변경되지 않은 건에 대해서만 복구 로직을 태움
                 * (이미 실패 처리된 건에 대해 중복으로 재고를 돌려주는 '이중 복구' 방지)
                 */
                if (reservation && reservation.status !== 'FAILED') {
                    
                    /**
                     * [DB 트랜잭션 시작] 
                     * 예약 상태 변경과 재고 복구는 반드시 동시에 이루어져야 하므로 원자적 작업을 보장함
                     */
                    await prisma.$transaction(async (tx) => {
                        // [DB 상태 변경] 예약의 상태를 'PENDING'에서 'FAILED'로 수정하여 취소됨을 명시함
                        await tx.reservations.update({
                            where: { ticket_code: orderId },
                            data: { status: 'FAILED' }
                        });
                        
                        // [DB 재고 복구] 해당 공연(event)의 잔여 좌석수를 취소된 티켓 수량만큼 다시 늘려줌
                        await tx.events.update({
                            where: { event_id: reservation.event_id },
                            data: { available_seats: { increment: reservation.ticket_count } }
                        });
                    });

                    /**
                     * [3] Redis 실시간 재고 복구
                     * DB 복구가 성공했다면, 실시간 선착순 처리가 이루어지는 Redis 메모리 재고 역시 즉시 원복함
                     * incrBy를 사용하여 원자적으로 숫자를 증가시킴
                     */
                    const stockKey = `event:stock:${reservation.event_id}`;
                    await redis.incrBy(stockKey, reservation.ticket_count);

                    console.log(`⏪ [롤백 완료] 주문 ${orderId} 취소 및 재고 복구 성공`);
                }
                
                // [메시지 확인 응답] 작업이 모두 끝났음을 RabbitMQ에 알려 메시지를 큐에서 제거함
                channel.ack(msg);
            } catch (error) {
                // [에러 핸들링] 롤백 과정 중 에러 발생 시 로그를 남기고 메시지를 큐로 돌려보내지 않음 (Dead Letter 방지 정책)
                console.error("❌ 취소 처리 중 오류:", error.message);
                channel.nack(msg, false, false);
            }
        });
    } catch (error) {
        console.error("❌ CancelConsumer 연결 실패:", error.message);
    }
}

module.exports = startCancelConsumer;