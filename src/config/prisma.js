const { PrismaClient } = require('@prisma/client');

/**
 * [Prisma 싱글톤 설정]
 * global 객체를 활용해 커넥션 풀이 넘치는 것을 방지함
 */
let prisma;

if (global.prisma) {
    prisma = global.prisma;
    console.log('♻️  [Prisma] 기존 커넥션 재사용 중');
} else {
    prisma = new PrismaClient();
    global.prisma = prisma;
    console.log('🆕 [Prisma] 새 커넥션 인스턴스 생성 완료');
}

module.exports = prisma;