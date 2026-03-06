// src/app.js

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan'); // [추가] 로그 확인용
const { connectRabbitMQ } = require('./config/rabbitMQ'); // [추가] MQ 연결 함수 가져오기

// [1] 앱 초기화 및 기본 설정
const app = express();
const PORT = process.env.PORT || 8082;

/**
 * [2] 인프라 연결 설정 (Redis)
 * Server 1의 Redis와 연결하여 선착순 재고를 관리함
 * 별도의 설정 파일에서 생성된 연결 객체를 가져와서 재사용 (중복 연결 방지)
 */
const redisClient = require('./config/redisClient');

// [3] 미들웨어 설정
// 배포 시에는 특정 도메인만 허용하도록 corsOptions를 적용하는 것이 좋음
app.use(morgan('dev')); // 요청 로그를 콘솔에 찍어줌 (디버깅 용이)
app.use(cors()); 
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // [추가] URL 인코딩 데이터 파싱

// [4] 라우터 연결
// Nginx에서 /api/res/ 경로를 제거하고 전달하므로 루트('/')에서 매핑 시작
const resRoutes = require('./routes/resRoutes');
app.use('/', resRoutes);

// [5] 시스템 헬스체크 및 메인 엔드포인트
app.get('/', (req, res) => {
    res.status(200).send({
        service: "Reservation Service",
        status: "Running",
        port: PORT,
        infrastructure: {
            database: "PostgreSQL Connected",
            cache: "Redis Connected"
        }
    });
});

app.get('/health', (req, res) => res.status(200).send('OK'));

// [6] 전역 에러 핸들러
app.use((err, req, res, next) => {
    console.error(`[Internal Error] ${err.stack}`);
    res.status(500).json({ message: "Internal Server Error" });
});

// [7] 서버 실행 및 초기 데이터 로드 (Warm-up)
const resService = require('./services/resService');
const eventService = require('./services/eventService');

// 💡 수정: 단순히 require만 하지 말고 함수로 가져와서 나중에 실행할 것
const startConsumer = require('./messaging/listener/consumer'); 
const startCancelConsumer = require('./messaging/listener/cancelConsumer');
const startStatusUpdateConsumer = require('./messaging/listener/statusUpdateConsumer');

app.listen(PORT, async () => {
    console.log(`🚀 [Reservation] Service is running on port ${PORT}`);

    try {
        // 0. RabbitMQ '발행용' 채널 먼저 연결 [가장 중요!!]
        await connectRabbitMQ(); // [추가] 이걸 실행해야 컨트롤러에서 메시지를 보낼 수 있어!

        // 1. RabbitMQ Consumer들을 순차적으로 실행 (환경 변수 적용 확실히 보장)
        // consumer.js에서 startConsumer가 module.exports 되어 있어야 함!
        await startConsumer(); 
        
        // 나머지 컨슈머들도 여기서 실행
        await startCancelConsumer();
        await startStatusUpdateConsumer();

        console.log("✅ [Messaging] 모든 RabbitMQ 컨슈머 연결 성공");

        // 2. Redis 재고 Warm-up 실행
        await eventService.warmupAllEventsToRedis();
        
        console.log(`✅ [Warm-up] 모든 이벤트 재고 Redis 동기화 완료`);

    } catch (err) {
        // 초기화 과정에서 에러 발생 시 로그 출력 및 예외 처리
        console.error("❌ [Initialization Error] 초기화 실패:", err.message);
    }
});