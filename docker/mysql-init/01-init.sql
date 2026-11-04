CREATE DATABASE IF NOT EXISTS `homglai_db`;
CREATE DATABASE IF NOT EXISTS `homglai_db_test`;
GRANT ALL PRIVILEGES ON `homglai_db`.* TO 'root'@'%';
GRANT ALL PRIVILEGES ON `homglai_db_test`.* TO 'root'@'%';
FLUSH PRIVILEGES;
