//src/messaging/listener/cencelConsumer.js

require('dotenv').config(); // 환경 변수 로드
const amqp = require('amqplib');
const cancelService = require('../../services/cancelService'); 

const startCancelConsumer = async () => {
    // 핵심 주석: 다른 컨슈머들과 동일하게 환경 변수 조합으로 일관성 유지 (하드코딩 방지)
    const mqUser = process.env.RABBITMQ_USER || 'guest';
    const mqPass = process.env.RABBITMQ_PASSWORD || 'guest';
    const mqHost = process.env.RABBITMQ_HOST || 'localhost';
    // RABBITMQ_URL이 있으면 쓰고, 없으면 조립해서 사용
    const rabbitUrl = process.env.RABBITMQ_URL || `amqp://${mqUser}:${mqPass}@${mqHost}:5672`;

    try {
        const connection = await amqp.connect(rabbitUrl);
        const channel = await connection.createChannel();
        
        // 💡 Exchange(msa.direct.exchange)를 통하지 않고 큐에 다이렉트로 꽂히는 메시지인지 확인 필요
        const queueName = 'reservation_cancel_queue';
        await channel.assertQueue(queueName, { durable: true });
        
        console.log(`🎧 [보상/취소 트랜잭션 대기 중] ${queueName} 감시 시작`);

        channel.consume(queueName, async (msg) => {
            if (!msg) return;

            try {
                const data = JSON.parse(msg.content.toString());
                
                // 핵심 주석: 복잡한 DB/Redis 롤백(취소) 로직은 서비스 레이어로 위임
                await cancelService.handleCompensation(data);
                
                console.log(`⏪ [취소/롤백 완료] 티켓코드: ${data.ticket_code}`);
                channel.ack(msg); // 처리 완료 알림
            } catch (error) {
                console.error('❌ [보상/취소 트랜잭션 실패]:', error.message);
                // 처리 실패 시 nack를 보내서 큐에 다시 넣기 (requeue: true)
                channel.nack(msg, false, true); 
            }
        });
    } catch (error) {
        console.error("❌ RabbitMQ 연결 실패:", error.message);
    }
};

module.exports = startCancelConsumer;