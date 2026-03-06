// src/messaging/listener/statusUpdateConsumer.js
require('dotenv').config();
const amqp = require('amqplib');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const redis = require('../../config/redisClient');

async function startStatusUpdateConsumer() {
    // 핵심 주석: 환경 변수로 접속 정보 동적 할당 (하드코딩 방지)
    const mqUser = process.env.RABBITMQ_USER || 'guest';
    const mqPass = process.env.RABBITMQ_PASSWORD || 'guest';
    const mqHost = process.env.RABBITMQ_HOST || 'localhost';
    const rabbitUrl = `amqp://${mqUser}:${mqPass}@${mqHost}:5672`;

    try {
        const connection = await amqp.connect(rabbitUrl);
        const channel = await connection.createChannel();

        const EXCHANGE_NAME = "msa.direct.exchange"; 
        const UPDATE_QUEUE = "res.status.update.queue";
        const ROUTING_KEY = "res.status.update"; 

        await channel.assertExchange(EXCHANGE_NAME, 'direct', { durable: true });
        await channel.assertQueue(UPDATE_QUEUE, { durable: true });
        await channel.bindQueue(UPDATE_QUEUE, EXCHANGE_NAME, ROUTING_KEY);

        console.log(`📩 [Status Consumer] 통합 결과 수신 대기 중 (Exchange: ${EXCHANGE_NAME}, Queue: ${UPDATE_QUEUE})...`);

        channel.consume(UPDATE_QUEUE, async (msg) => {
            if (!msg) return;

            const response = JSON.parse(msg.content.toString());
            console.log("-----------------------------------------");
            console.log("📩 [수신 데이터 확인]:", response); 
            console.log("-----------------------------------------");

            // 핵심 주석: 실패 사유(message)도 함께 추출해서 로깅에 활용
            const { orderId, status, type, message } = response; 

            // 💡 1. 들어온 상태값을 대문자로 정규화 (null 체크 포함)
            const normalizedStatus = status ? status.toUpperCase() : '';

            try {
                // normalizedStatus는 "정규화(Normalization)된 상태"라는 뜻
                // ⭐ [추가] 결제/환불 실패 (FAIL) 시 보상 트랜잭션 로직
                if (normalizedStatus === 'FAIL' || normalizedStatus === 'FAILED') {
                    console.error(`❌ [처리 실패] 주문: ${orderId}, 사유: ${message}`);
                    
                    const reservation = await prisma.reservations.findUnique({
                        where: { ticket_code: orderId }
                    });

                    // 아직 취소(FAILED) 처리가 안 된 건이라면 DB 및 재고 롤백
                    if (reservation && reservation.status !== 'FAILED') {
                        await prisma.$transaction(async (tx) => {
                            await tx.reservations.update({
                                where: { ticket_code: orderId },
                                data: { status: 'FAILED' }  // DB는 우리 표준인 'FAILED'로 저장
                            });
                            await tx.events.update({
                                where: { event_id: reservation.event_id },
                                data: { available_seats: { increment: reservation.ticket_count } }
                            });
                        });

                        const stockKey = `event:stock:${reservation.event_id}`;
                        await redis.incrBy(stockKey, reservation.ticket_count);
                        console.log(`⏪ [롤백 완료] 주문 ${orderId} -> FAILED 변경 및 재고 복구 완료`);
                    }
                } 
                // ⭐ 3. 성공 및 환불 확정 로직 (배열을 써서 깔끔하게 비교)
                else if (['COMPLETE', 'SUCCESS', 'REFUNDED'].includes(normalizedStatus)) {
                    if (type === 'REFUND' || status === 'REFUNDED') {
                        console.log(`♻️ [환불 확정] DB 업데이트 시작: ${orderId}`);

                        const reservation = await prisma.reservations.findUnique({
                            where: { ticket_code: orderId }
                        });

                        if (reservation && reservation.status !== 'REFUNDED') {
                            await prisma.$transaction(async (tx) => {
                                await tx.reservations.update({
                                    where: { ticket_code: orderId },
                                    data: { status: 'REFUNDED' }
                                });
                                await tx.events.update({
                                    where: { event_id: reservation.event_id },
                                    data: { available_seats: { increment: reservation.ticket_count } }
                                });
                            });

                            const stockKey = `event:stock:${reservation.event_id}`;
                            await redis.incrBy(stockKey, reservation.ticket_count);
                            
                            console.log(`🚀 [복구 완료] 주문 ${orderId} -> REFUNDED 변경 및 재고 환원 완료`);
                        }
                    } else {
                        // 결제 완료 처리
                        await prisma.reservations.update({
                            where: { ticket_code: orderId },
                            data: { status: 'CONFIRMED' }
                        });
                        console.log(`✅ [결제 완료] 주문 ${orderId} -> CONFIRMED 변경`);
                    }
                }
                
                // 정상 처리 완료 시에만 메시지 삭제
                channel.ack(msg);
            } catch (error) {
                console.error("❌ 컨슈머 내부 처리 에러:", error.message);
                // DB 에러 등 내부 오류 시 nack로 큐에 유지(또는 버림)
                channel.nack(msg, false, false); 
            }
        });

    } catch (error) {
        console.error("❌ RabbitMQ 연결 또는 채널 생성 에러:", error.message);
    }
}

module.exports = startStatusUpdateConsumer;