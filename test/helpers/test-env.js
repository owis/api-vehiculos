// Helpers de entorno para tests en host: api/.env trae hostnames docker
// (db, redis) que no resuelven fuera de compose. El gate fija
// DB_HOST=127.0.0.1 por CLI; aquí se aplica lo mismo a REDIS_HOST solo
// cuando no viene definido (en contenedor compose manda su env real y
// dotenv nunca sobrescribe, así que esto no altera docker).
if (!process.env.REDIS_HOST) process.env.REDIS_HOST = '127.0.0.1';
