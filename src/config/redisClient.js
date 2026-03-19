// src/config/redisClient.js

const redis = require('redis');
const dotenv = require('dotenv');

// [1] 환경변수 로드 (.env 파일 설정 적용)
dotenv.config();

/**
 * [2] Redis 클라이언트 인스턴스 생성
 * 핵심 주석: 인프라 서버(Server 1)에 설치된 Redis 정보를 바탕으로 연결 설정
 */
const redisClient = redis.createClient({
    url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`,
    password: process.env.REDIS_PASSWORD || undefined
});

// [3] Redis 연결 상태 모니터링 이벤트 리스너
// 핵심 주석: 연결 프로세스 각 단계(시도 -> 성공 -> 에러 -> 종료)를 로그로 출력하여 가시성 확보
redisClient.on('connect', () => {
    console.log('✅ Redis 연결 시도 중...');
});

redisClient.on('ready', () => {
    console.log('🚀 Redis 연결 성공!');
});

redisClient.on('error', (err) => {
    console.error('❌ Redis 연결 에러:', err);
});

redisClient.on('end', () => {
    console.log('Disconnected from Redis');
});

/**
 * [4] Redis 클라이언트 연결 실행 (V4 버전 필수사항)
 * 핵심 주석: redis 라이브러리 v4부터는 connect()를 비동기로 호출해야 실제 연결이 시작됨
 */
(async () => {
    try {
        await redisClient.connect();
    } catch (err) {
        console.error('⚠️ Redis 초기 연결 실패:', err);
    }
})();

/**
 * [5] 싱글톤 인스턴스 내보내기
 * 핵심 주석: 다른 서비스(Repository 등)에서 동일한 연결 객체를 공유하여 자원 낭비를 방지함
 */
module.exports = redisClient;
