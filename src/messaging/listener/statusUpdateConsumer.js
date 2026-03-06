const amqp = require('amqplib');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const redis = require('../../config/redisClient');
const { QUEUES, EXCHANGE, ROUTING_KEYS } = require('../../config/rabbitMQ');

/**
 * 결제 서버(Spring)로부터 받은 최종 처리 결과(성공/실패/환불)를 
 * 우리 DB 및 Redis 재고에 동기화하는 소비자 함수야.
 */
async function startStatusUpdateConsumer() {
    // 환경 변수에서 RabbitMQ 접속 정보를 가져와
    const rabbitUrl = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}@${process.env.RABBITMQ_HOST}:5672`;

    try {
        const connection = await amqp.connect(rabbitUrl);
        const channel = await connection.createChannel();

        // 중앙 설정 파일(rabbitMQ.js)에 정의된 큐와 익스체인지를 사용해
        await channel.assertQueue(QUEUES.STATUS_UPDATE, { durable: true });
        await channel.bindQueue(QUEUES.STATUS_UPDATE, EXCHANGE, ROUTING_KEYS.STATUS_UPDATE);

        console.log(`📩 [Status Consumer] 결과 수신 대기 중: ${QUEUES.STATUS_UPDATE}`);

        channel.consume(QUEUES.STATUS_UPDATE, async (msg) => {
            if (!msg) return;

            // 수신된 메시지를 JSON 객체로 파싱해
            const response = JSON.parse(msg.content.toString());
            const { orderId, status, type, message } = response;
            
            // 상태값을 비교하기 쉽게 대문자로 통일해 (예: success -> SUCCESS)
            const normalizedStatus = status ? status.toUpperCase() : '';

            try {
                // 1. 결제 실패 상황 처리 (FAIL 또는 FAILED)
                if (['FAIL', 'FAILED'].includes(normalizedStatus)) {
                    console.error(`❌ [결제 실패 수신] 주문번호: ${orderId}, 사유: ${message}`);
                    
                    // DB에서 해당 주문이 있는지 먼저 조회해
                    const res = await prisma.reservations.findUnique({ where: { ticket_code: orderId } });
                    
                    // 데이터가 존재하고 아직 실패 처리가 안 된 경우에만 로직 실행
                    if (res && res.status !== 'FAILED') {
                        await prisma.$transaction(async (tx) => {
                            // 예약 상태를 FAILED로 변경
                            await tx.reservations.update({ where: { ticket_code: orderId }, data: { status: 'FAILED' } });
                            // DB의 이벤트 잔여 좌석을 다시 늘려줘
                            await tx.events.update({ where: { event_id: res.event_id }, data: { available_seats: { increment: res.ticket_count } } });
                        });
                        // Redis에 저장된 실시간 재고도 다시 복구해
                        await redis.incrBy(`event:stock:${res.event_id}`, res.ticket_count);
                        console.log(`⏪ [롤백 완료] 주문 ${orderId} 재고 복구 성공`);
                    }
                } 
                
                // 2. 결제 성공 또는 환불 확정 상황 처리
                else if (['COMPLETE', 'SUCCESS', 'REFUNDED'].includes(normalizedStatus)) {
                    
                    // [환불 처리] 타입이 REFUND이거나 상태가 REFUNDED인 경우
                    if (type === 'REFUND' || normalizedStatus === 'REFUNDED') {
                        const res = await prisma.reservations.findUnique({ where: { ticket_code: orderId } });
                        
                        if (res && res.status !== 'REFUNDED') {
                            await prisma.$transaction(async (tx) => {
                                // 예약 상태를 REFUNDED로 변경
                                await tx.reservations.update({ where: { ticket_code: orderId }, data: { status: 'REFUNDED' } });
                                // 환불되었으니 좌석을 다시 확보해
                                await tx.events.update({ where: { event_id: res.event_id }, data: { available_seats: { increment: res.ticket_count } } });
                            });
                            await redis.incrBy(`event:stock:${res.event_id}`, res.ticket_count);
                            console.log(`♻️ [환불 완료] 주문 ${orderId} 재고 환원 성공`);
                        }
                    } 
                    // [결제 완료 처리] 일반 결제 성공인 경우
                    else {
                        // 💡 중요: 업데이트 전에 데이터가 있는지 확인하여 "No record found" 에러 방지
                        const res = await prisma.reservations.findUnique({ where: { ticket_code: orderId } });
                        
                        if (res) {
                            await prisma.reservations.update({
                                where: { ticket_code: orderId },
                                data: { status: 'CONFIRMED' }
                            });
                            console.log(`✅ [결제 완료] 주문 ${orderId} -> CONFIRMED 상태 변경`);
                        } else {
                            // 데이터가 없으면 무리하게 업데이트하지 않고 로그만 남겨
                            console.warn(`⚠️ [경고] DB에 존재하지 않는 티켓(${orderId})의 결제 성공 메시지를 수신함`);
                        }
                    }
                }

                // 처리가 완료되면 큐에서 메시지를 삭제해
                channel.ack(msg);

            } catch (error) {
                console.error("❌ 처리 도중 내부 오류 발생:", error.message);
                // 오류 발생 시 메시지를 다시 큐에 넣지 않고 일단 버림 (무한 루프 방지)
                channel.nack(msg, false, false);
            }
        });
    } catch (error) {
        console.error("❌ StatusUpdateConsumer 연결 실패:", error.message);
    }
}

module.exports = startStatusUpdateConsumer;