// src/messaging/listener/dashboardConsumer.js
const { getConnection } = require('../../config/rabbitMQ');

/**
 * [유저 대시보드 전용 컨슈머]
 * MSA 구조에서 대시보드 서비스가 타 서비스(이벤트, 예약 등)로부터 발생하는 메시지를 수신하는 역할.
 * 전체 이벤트 목록 및 로그인 유저의 예매 내역 메시지를 실시간으로 감시함.
 */
async function startDashboardConsumer() {
    try {
        // [초기화] RabbitMQ 설정 파일로부터 기존 연결 객체를 가져옴
        const connection = getConnection();
        
        // 커넥션이 유효하지 않을 경우, 에러 메시지 출력 후 프로세스 중단 (방어 코드)
        if (!connection) return console.error("❌ RabbitMQ 연결 실패");

        // 메시지 송수신을 위한 가상 통로인 채널(Channel) 생성
        const channel = await connection.createChannel();

        /**
         * [1] 전체 이벤트 리스트 큐 설정 및 수신
         * 용도: 새로운 이벤트가 등록되거나 변경될 때 모든 사용자에게 공지하기 위한 데이터 수신
         */
        const ALL_EVENTS_QUEUE = 'all_events_queue';
        
        // 큐가 없으면 생성하고, durable: true를 통해 브로커가 재시작되어도 큐를 유지함
        await channel.assertQueue(ALL_EVENTS_QUEUE, { durable: true });
        
        // 지정된 큐로부터 메시지를 무기한 대기(Subscribe)
        channel.consume(ALL_EVENTS_QUEUE, (msg) => {
            // 메시지가 null인 경우(큐 삭제 등) 예외 처리
            if (!msg) return;
            
            // Buffer 형태의 메시지 본문을 JSON 객체로 파싱
            const data = JSON.parse(msg.content.toString());
            console.log("📥 [Dashboard Consumer] 전체 이벤트 목록 수신 완료");
            
            // TODO: Socket.io 등을 통해 프론트로 전송하는 로직 추가 지점
            
            // 메시지 처리가 완료되었음을 브로커에 알림(Ack)하여 큐에서 메시지 제거
            channel.ack(msg);
        });

        /**
         * [2] 유저 예매 확정 내역 큐 설정 및 수신
         * 용도: 특정 유저의 예약 성공 여부를 실시간으로 대시보드에 반영하기 위함
         */
        const USER_RES_QUEUE = 'user_reservation_queue';
        
        // 예약 정보의 중요성을 고려하여 메시지 보존(durable) 설정 유지
        await channel.assertQueue(USER_RES_QUEUE, { durable: true });

        channel.consume(USER_RES_QUEUE, (msg) => {
            if (!msg) return;
            
            // 유저 ID 및 예약 상세 정보가 담긴 데이터 파싱
            const data = JSON.parse(msg.content.toString());
            console.log(`📥 [Dashboard Consumer] 유저(${data.userId}) 예매 내역 수신 완료`);
            
            // TODO: 특정 유저 세션으로 실시간 전송하는 로직 추가 지점
            
            // 성공적인 수신 및 로직 처리 완료 통보
            channel.ack(msg);
        });

        console.log("✅ Dashboard Consumer 가동 중...");
    } catch (err) {
        // 네트워크 장애 또는 채널 생성 실패 등 런타임 에러 발생 시 로깅
        console.error("❌ Dashboard Consumer 초기화 에러:", err.message);
    }
}

// 외부에서 컨슈머를 구동할 수 있도록 모듈 내보내기
module.exports = startDashboardConsumer;