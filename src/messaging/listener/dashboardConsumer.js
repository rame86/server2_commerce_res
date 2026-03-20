// src/messaging/listener/dashboardConsumer.js
const { getConnection } = require('../../config/rabbitMQ');

/**
 * [유저 대시보드 전용 컨슈머]
 * 전체 이벤트 목록 및 로그인 유저의 예매 내역 메시지를 수신함
 */
async function startDashboardConsumer() {
    try {
        const connection = getConnection();
        if (!connection) return console.error("❌ RabbitMQ 연결 실패");

        const channel = await connection.createChannel();

        // [1] 전체 이벤트 리스트 큐 설정 및 수신
        const ALL_EVENTS_QUEUE = 'all_events_queue';
        await channel.assertQueue(ALL_EVENTS_QUEUE, { durable: true });
        
        channel.consume(ALL_EVENTS_QUEUE, (msg) => {
            if (!msg) return;
            const data = JSON.parse(msg.content.toString());
            console.log("📥 [Dashboard Consumer] 전체 이벤트 목록 수신 완료");
            
            // TODO: Socket.io 등을 통해 프론트로 전송하는 로직 추가 지점
            channel.ack(msg);
        });

        // [2] 유저 예매 확정 내역 큐 설정 및 수신
        const USER_RES_QUEUE = 'user_reservation_queue';
        await channel.assertQueue(USER_RES_QUEUE, { durable: true });

        channel.consume(USER_RES_QUEUE, (msg) => {
            if (!msg) return;
            const data = JSON.parse(msg.content.toString());
            console.log(`📥 [Dashboard Consumer] 유저(${data.userId}) 예매 내역 수신 완료`);
            
            // TODO: 특정 유저 세션으로 실시간 전송하는 로직 추가 지점
            channel.ack(msg);
        });

        console.log("✅ Dashboard Consumer 가동 중...");
    } catch (err) {
        console.error("❌ Dashboard Consumer 초기화 에러:", err.message);
    }
}

module.exports = startDashboardConsumer;