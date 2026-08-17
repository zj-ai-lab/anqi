import passwordHash from '../src/lib/password-hash.cjs';

const password = process.env.ANJIAN_PASSWORD;
if (!password) {
  console.error('请通过 ANJIAN_PASSWORD 环境变量传入待哈希密码；明文不会写入文件。');
  process.exit(2);
}

console.log(passwordHash.hashPassword(password));
