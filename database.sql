PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, english_level TEXT, points INTEGER DEFAULT 0, google_id TEXT, last_active DATETIME DEFAULT CURRENT_TIMESTAMP, password_hash TEXT);
INSERT INTO "users" VALUES('334cca29-3d21-4307-868b-19c7935ea74f','test_user','test@example.com','2025-10-31 20:06:50','beginner',10,'mock_4b01e288-3ce7-4916-93e5-0d119583fa4d','2025-10-31 20:06:50',NULL);
INSERT INTO "users" VALUES('1add7136-d602-4089-8bdc-b73643278c42','test2','test2@mydomain.com','2025-10-31 20:20:49','beginner',0,NULL,'2025-10-31 20:57:48',NULL);
INSERT INTO "users" VALUES('19cb25ff-237a-4fdf-901c-b9384a3f7e09','rahman_khan','john@chatter3.com','2025-10-31 20:26:42','beginner',240,'115198133369826966680','2025-11-27 14:21:14',NULL);
INSERT INTO "users" VALUES('eaf291c3-82aa-414e-9bee-5ee08622d78d','trustnet_bangladesh','trustnet.com.bd@gmail.com','2025-10-31 22:26:55','beginner',90,'112579368377146042419','2025-11-20 18:45:00',NULL);
INSERT INTO "users" VALUES('74b4c524-8c24-4686-a273-6a209cb510cd','Dax','dax@chatter3.com','2025-11-01 05:35:37','beginner',0,NULL,'2025-11-01 05:35:37','$2b$10$j.nVKiVyrb2Mk.AOi15.Netg9X3bV0eQqLsltamy5dudWiVBzbgzO');
INSERT INTO "users" VALUES('b7038f92-2015-4b83-bf40-9ccbdc99dd3e','kobayashi_daisuke','koba.daichan@gmail.com','2025-11-06 05:32:23','beginner',10,'101772999542071083242','2025-11-06 05:32:24',NULL);
INSERT INTO "users" VALUES('24e2e298-88c9-4a35-af04-7ff4e6631fb6','schemadyn_inc.','schemadyn@gmail.com','2025-11-20 18:47:46','beginner',130,'113541307722706503029','2025-11-20 20:56:24',NULL);
CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE messages (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL, content TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE matching_queue (
  user_id TEXT PRIMARY KEY,
  english_level TEXT NOT NULL,
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
INSERT INTO "matching_queue" VALUES('19cb25ff-237a-4fdf-901c-b9384a3f7e09','beginner','2025-11-27 14:21:20');
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user1_id TEXT NOT NULL,
  user2_id TEXT NOT NULL,
  english_level TEXT NOT NULL,
  status TEXT DEFAULT 'matching',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  ended_at DATETIME,
  duration INTEGER,
  room_name TEXT,
  FOREIGN KEY (user1_id) REFERENCES users(id),
  FOREIGN KEY (user2_id) REFERENCES users(id)
);
INSERT INTO "sessions" VALUES('d8eca127-c15a-4ea5-8d6d-d3b3971bfe55','19cb25ff-237a-4fdf-901c-b9384a3f7e09','334cca29-3d21-4307-868b-19c7935ea74f','beginner','completed','2025-10-31 22:19:11',NULL,'2025-10-31 22:19:58',47,'video_room_d8eca127-c15a-4ea5-8d6d-d3b3971bfe55');
INSERT INTO "sessions" VALUES('372d5911-67de-48b7-a442-af12e7eb1ed2','eaf291c3-82aa-414e-9bee-5ee08622d78d','19cb25ff-237a-4fdf-901c-b9384a3f7e09','beginner','completed','2025-10-31 22:27:07',NULL,'2025-10-31 22:28:06',59,'video_room_372d5911-67de-48b7-a442-af12e7eb1ed2');
INSERT INTO "sessions" VALUES('f5de55bf-0e7d-4bbd-b5b0-710d93417795','eaf291c3-82aa-414e-9bee-5ee08622d78d','19cb25ff-237a-4fdf-901c-b9384a3f7e09','beginner','completed','2025-11-01 07:34:56',NULL,'2025-11-01 07:40:52',355,'video_room_f5de55bf-0e7d-4bbd-b5b0-710d93417795');
INSERT INTO "sessions" VALUES('072acda8-b5f3-4a11-8461-9ab3978e2adc','19cb25ff-237a-4fdf-901c-b9384a3f7e09','eaf291c3-82aa-414e-9bee-5ee08622d78d','beginner','completed','2025-11-01 08:13:13',NULL,'2025-11-01 09:43:28',5415,'video_room_072acda8-b5f3-4a11-8461-9ab3978e2adc');
INSERT INTO "sessions" VALUES('8d1f4508-84f1-4ad6-a667-9b62b299e616','b7038f92-2015-4b83-bf40-9ccbdc99dd3e','19cb25ff-237a-4fdf-901c-b9384a3f7e09','beginner','completed','2025-11-06 05:34:54',NULL,'2025-11-20 14:33:56',1241942,'video_room_8d1f4508-84f1-4ad6-a667-9b62b299e616');
INSERT INTO "sessions" VALUES('0e78a030-d451-4b07-9bef-decea5ba4e81','eaf291c3-82aa-414e-9bee-5ee08622d78d','19cb25ff-237a-4fdf-901c-b9384a3f7e09','beginner','completed','2025-11-20 18:45:03',NULL,'2025-11-20 18:46:05',62,'video_room_0e78a030-d451-4b07-9bef-decea5ba4e81');
INSERT INTO "sessions" VALUES('db4aab04-fede-4cc7-9be6-64fa64dd6a80','eaf291c3-82aa-414e-9bee-5ee08622d78d','19cb25ff-237a-4fdf-901c-b9384a3f7e09','beginner','completed','2025-11-20 18:46:47',NULL,'2025-11-20 18:47:03',16,'video_room_db4aab04-fede-4cc7-9be6-64fa64dd6a80');
INSERT INTO "sessions" VALUES('5aa164c8-512a-4c65-a92d-d2445afdb796','19cb25ff-237a-4fdf-901c-b9384a3f7e09','24e2e298-88c9-4a35-af04-7ff4e6631fb6','beginner','completed','2025-11-20 18:48:01',NULL,'2025-11-20 18:48:36',35,'video_room_5aa164c8-512a-4c65-a92d-d2445afdb796');
INSERT INTO "sessions" VALUES('fcdd3f48-1662-4cad-89d0-e256742f960b','19cb25ff-237a-4fdf-901c-b9384a3f7e09','24e2e298-88c9-4a35-af04-7ff4e6631fb6','beginner','completed','2025-11-20 19:06:09',NULL,'2025-11-20 19:08:06',116,'video_room_fcdd3f48-1662-4cad-89d0-e256742f960b');
INSERT INTO "sessions" VALUES('18692cfe-e9f6-49c5-9be4-ba5da1f4400d','19cb25ff-237a-4fdf-901c-b9384a3f7e09','24e2e298-88c9-4a35-af04-7ff4e6631fb6','beginner','completed','2025-11-20 19:08:13',NULL,'2025-11-20 19:08:37',24,'video_room_18692cfe-e9f6-49c5-9be4-ba5da1f4400d');
INSERT INTO "sessions" VALUES('134a809b-9189-44f7-b54a-d2eac0d75337','24e2e298-88c9-4a35-af04-7ff4e6631fb6','19cb25ff-237a-4fdf-901c-b9384a3f7e09','beginner','completed','2025-11-20 19:09:40',NULL,'2025-11-20 19:10:35',55,'video_room_134a809b-9189-44f7-b54a-d2eac0d75337');
INSERT INTO "sessions" VALUES('67ae1689-4ae3-42ed-9b03-549a9477fa87','19cb25ff-237a-4fdf-901c-b9384a3f7e09','24e2e298-88c9-4a35-af04-7ff4e6631fb6','beginner','completed','2025-11-20 19:10:38',NULL,'2025-11-20 19:10:50',12,'video_room_67ae1689-4ae3-42ed-9b03-549a9477fa87');
INSERT INTO "sessions" VALUES('24b1c41a-1a40-464b-8bcd-6d6024b2dbdf','19cb25ff-237a-4fdf-901c-b9384a3f7e09','24e2e298-88c9-4a35-af04-7ff4e6631fb6','beginner','completed','2025-11-20 19:15:24',NULL,'2025-11-20 19:15:44',20,'video_room_24b1c41a-1a40-464b-8bcd-6d6024b2dbdf');
INSERT INTO "sessions" VALUES('6e4b3836-d52b-485e-8b24-fd34a1f58acf','24e2e298-88c9-4a35-af04-7ff4e6631fb6','19cb25ff-237a-4fdf-901c-b9384a3f7e09','beginner','completed','2025-11-20 19:16:19',NULL,'2025-11-20 20:36:17',4798,'video_room_6e4b3836-d52b-485e-8b24-fd34a1f58acf');
INSERT INTO "sessions" VALUES('a1c4ec0b-fd58-44b2-bfe9-1cb496506e93','24e2e298-88c9-4a35-af04-7ff4e6631fb6','19cb25ff-237a-4fdf-901c-b9384a3f7e09','beginner','active','2025-11-20 20:30:39',NULL,NULL,NULL,'video_room_a1c4ec0b-fd58-44b2-bfe9-1cb496506e93');
INSERT INTO "sessions" VALUES('bc97ed46-895d-44b4-992e-f9b3f20ffd55','24e2e298-88c9-4a35-af04-7ff4e6631fb6','19cb25ff-237a-4fdf-901c-b9384a3f7e09','beginner','completed','2025-11-20 20:47:57',NULL,'2025-11-20 20:54:23',386,'video_room_bc97ed46-895d-44b4-992e-f9b3f20ffd55');
INSERT INTO "sessions" VALUES('fb5768b9-d90f-4fbf-baf2-900ef3e7cc93','24e2e298-88c9-4a35-af04-7ff4e6631fb6','19cb25ff-237a-4fdf-901c-b9384a3f7e09','beginner','active','2025-11-20 20:54:30',NULL,NULL,NULL,'video_room_fb5768b9-d90f-4fbf-baf2-900ef3e7cc93');
CREATE TABLE point_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  points INTEGER NOT NULL,
  activity_type TEXT NOT NULL,
  session_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
INSERT INTO "point_transactions" VALUES('c245d921-d282-4972-ab3f-0d342667837e','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','d8eca127-c15a-4ea5-8d6d-d3b3971bfe55','2025-10-31 22:19:59');
INSERT INTO "point_transactions" VALUES('c82f910d-6f4b-4fda-b9ea-aeeb7be8e740','334cca29-3d21-4307-868b-19c7935ea74f',10,'video_call','d8eca127-c15a-4ea5-8d6d-d3b3971bfe55','2025-10-31 22:19:59');
INSERT INTO "point_transactions" VALUES('923c9f2f-5530-4761-9e51-19297ee964d2','eaf291c3-82aa-414e-9bee-5ee08622d78d',10,'video_call','372d5911-67de-48b7-a442-af12e7eb1ed2','2025-10-31 22:28:06');
INSERT INTO "point_transactions" VALUES('ea19440e-96e7-47f5-ae1e-bc3710f07e3f','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','372d5911-67de-48b7-a442-af12e7eb1ed2','2025-10-31 22:28:06');
INSERT INTO "point_transactions" VALUES('db620f96-a986-4b13-93c1-8ae72ab67219','eaf291c3-82aa-414e-9bee-5ee08622d78d',10,'video_call','f5de55bf-0e7d-4bbd-b5b0-710d93417795','2025-11-01 07:40:52');
INSERT INTO "point_transactions" VALUES('20b7d254-3ffd-4a22-9087-9e0a7e78afeb','eaf291c3-82aa-414e-9bee-5ee08622d78d',10,'video_call','f5de55bf-0e7d-4bbd-b5b0-710d93417795','2025-11-01 07:40:52');
INSERT INTO "point_transactions" VALUES('72b2fbb9-9e67-418f-9322-72c438d8cfc1','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','f5de55bf-0e7d-4bbd-b5b0-710d93417795','2025-11-01 07:40:52');
INSERT INTO "point_transactions" VALUES('231a024b-7a8b-419b-a109-9241b889c342','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','f5de55bf-0e7d-4bbd-b5b0-710d93417795','2025-11-01 07:40:52');
INSERT INTO "point_transactions" VALUES('eef1146a-090a-452b-bcaf-1d872dad4bf0','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','072acda8-b5f3-4a11-8461-9ab3978e2adc','2025-11-01 08:14:25');
INSERT INTO "point_transactions" VALUES('efea0310-18b0-4763-a945-2e293983a443','eaf291c3-82aa-414e-9bee-5ee08622d78d',10,'video_call','072acda8-b5f3-4a11-8461-9ab3978e2adc','2025-11-01 08:14:25');
INSERT INTO "point_transactions" VALUES('bb3550ee-44ad-4962-9e7c-58454bcdd77e','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','072acda8-b5f3-4a11-8461-9ab3978e2adc','2025-11-01 09:43:28');
INSERT INTO "point_transactions" VALUES('66c24a34-bfa0-4a0d-8995-1bf38ba4934d','eaf291c3-82aa-414e-9bee-5ee08622d78d',10,'video_call','072acda8-b5f3-4a11-8461-9ab3978e2adc','2025-11-01 09:43:28');
INSERT INTO "point_transactions" VALUES('0387ea39-13fb-4dd8-94c4-e818bf265a19','b7038f92-2015-4b83-bf40-9ccbdc99dd3e',10,'video_call','8d1f4508-84f1-4ad6-a667-9b62b299e616','2025-11-20 14:33:56');
INSERT INTO "point_transactions" VALUES('8269bf25-8016-444e-b543-ec9114ed2ead','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','8d1f4508-84f1-4ad6-a667-9b62b299e616','2025-11-20 14:33:56');
INSERT INTO "point_transactions" VALUES('e737e04c-8309-41f0-bb12-5f784d7436d3','eaf291c3-82aa-414e-9bee-5ee08622d78d',10,'video_call','0e78a030-d451-4b07-9bef-decea5ba4e81','2025-11-20 18:45:54');
INSERT INTO "point_transactions" VALUES('c7e91abd-ddba-49a3-b1d1-56d532f3c1e8','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','0e78a030-d451-4b07-9bef-decea5ba4e81','2025-11-20 18:45:54');
INSERT INTO "point_transactions" VALUES('2aeff738-ca94-4a86-b2c2-28bf48ce471b','eaf291c3-82aa-414e-9bee-5ee08622d78d',10,'video_call','0e78a030-d451-4b07-9bef-decea5ba4e81','2025-11-20 18:46:05');
INSERT INTO "point_transactions" VALUES('2777a5c9-aba3-43b6-b682-6b21ef182525','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','0e78a030-d451-4b07-9bef-decea5ba4e81','2025-11-20 18:46:05');
INSERT INTO "point_transactions" VALUES('85da15d6-b27c-4aaa-9738-e5cd86984b03','eaf291c3-82aa-414e-9bee-5ee08622d78d',10,'video_call','db4aab04-fede-4cc7-9be6-64fa64dd6a80','2025-11-20 18:46:58');
INSERT INTO "point_transactions" VALUES('b07ffbe7-8c87-47d3-adb7-798106f4b841','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','db4aab04-fede-4cc7-9be6-64fa64dd6a80','2025-11-20 18:46:58');
INSERT INTO "point_transactions" VALUES('32b4af67-2709-4288-afdc-174975121878','eaf291c3-82aa-414e-9bee-5ee08622d78d',10,'video_call','db4aab04-fede-4cc7-9be6-64fa64dd6a80','2025-11-20 18:47:03');
INSERT INTO "point_transactions" VALUES('e56877e3-323c-4527-8a53-3b48376158f2','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','db4aab04-fede-4cc7-9be6-64fa64dd6a80','2025-11-20 18:47:03');
INSERT INTO "point_transactions" VALUES('be1de91d-e160-4c21-8bc7-b5e13ac978e2','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','5aa164c8-512a-4c65-a92d-d2445afdb796','2025-11-20 18:48:36');
INSERT INTO "point_transactions" VALUES('33c570f1-72ab-4759-9bb7-2f1f0e2c06bc','24e2e298-88c9-4a35-af04-7ff4e6631fb6',10,'video_call','5aa164c8-512a-4c65-a92d-d2445afdb796','2025-11-20 18:48:36');
INSERT INTO "point_transactions" VALUES('68569150-1a6d-4384-9131-95f97d295ffd','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','fcdd3f48-1662-4cad-89d0-e256742f960b','2025-11-20 19:08:06');
INSERT INTO "point_transactions" VALUES('03e76bdb-f7c4-46e9-84d7-d063ff99849d','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','fcdd3f48-1662-4cad-89d0-e256742f960b','2025-11-20 19:08:06');
INSERT INTO "point_transactions" VALUES('97e49fd4-f357-4e02-b84c-67a3bc285b17','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','fcdd3f48-1662-4cad-89d0-e256742f960b','2025-11-20 19:08:06');
INSERT INTO "point_transactions" VALUES('8ed6db00-5ef1-4ad9-baee-5b10b6a17c3a','24e2e298-88c9-4a35-af04-7ff4e6631fb6',10,'video_call','fcdd3f48-1662-4cad-89d0-e256742f960b','2025-11-20 19:08:06');
INSERT INTO "point_transactions" VALUES('eb778f6d-ab6d-4d62-98de-e6637a328a25','24e2e298-88c9-4a35-af04-7ff4e6631fb6',10,'video_call','fcdd3f48-1662-4cad-89d0-e256742f960b','2025-11-20 19:08:06');
INSERT INTO "point_transactions" VALUES('346a4d48-be33-4123-a2d9-5886560665ce','24e2e298-88c9-4a35-af04-7ff4e6631fb6',10,'video_call','fcdd3f48-1662-4cad-89d0-e256742f960b','2025-11-20 19:08:06');
INSERT INTO "point_transactions" VALUES('ec57db14-8bee-4474-81fd-1ebf199e95b8','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','18692cfe-e9f6-49c5-9be4-ba5da1f4400d','2025-11-20 19:08:34');
INSERT INTO "point_transactions" VALUES('0f807c30-5911-4013-b0e6-1a0f72a24810','24e2e298-88c9-4a35-af04-7ff4e6631fb6',10,'video_call','18692cfe-e9f6-49c5-9be4-ba5da1f4400d','2025-11-20 19:08:34');
INSERT INTO "point_transactions" VALUES('dbcfb7a3-9020-438c-a7d0-1b75cf01546b','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','18692cfe-e9f6-49c5-9be4-ba5da1f4400d','2025-11-20 19:08:37');
INSERT INTO "point_transactions" VALUES('e4997c79-bd78-40f2-9bd7-c8b7c4794332','24e2e298-88c9-4a35-af04-7ff4e6631fb6',10,'video_call','18692cfe-e9f6-49c5-9be4-ba5da1f4400d','2025-11-20 19:08:37');
INSERT INTO "point_transactions" VALUES('7e62dcf3-db3f-41b8-91b0-06b17db22a0a','24e2e298-88c9-4a35-af04-7ff4e6631fb6',10,'video_call','134a809b-9189-44f7-b54a-d2eac0d75337','2025-11-20 19:10:24');
INSERT INTO "point_transactions" VALUES('474b910b-c0fd-489d-9ed6-90dac758f050','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','134a809b-9189-44f7-b54a-d2eac0d75337','2025-11-20 19:10:24');
INSERT INTO "point_transactions" VALUES('99e8ce22-9e49-4335-857c-f0d689da774f','24e2e298-88c9-4a35-af04-7ff4e6631fb6',10,'video_call','134a809b-9189-44f7-b54a-d2eac0d75337','2025-11-20 19:10:35');
INSERT INTO "point_transactions" VALUES('55d2a246-0093-4bff-ada3-7086623750b3','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','134a809b-9189-44f7-b54a-d2eac0d75337','2025-11-20 19:10:35');
INSERT INTO "point_transactions" VALUES('9753e1be-62f8-4041-8a97-632ff969126b','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','67ae1689-4ae3-42ed-9b03-549a9477fa87','2025-11-20 19:10:46');
INSERT INTO "point_transactions" VALUES('dc697e92-0f1b-4e35-b475-b60137400945','24e2e298-88c9-4a35-af04-7ff4e6631fb6',10,'video_call','67ae1689-4ae3-42ed-9b03-549a9477fa87','2025-11-20 19:10:46');
INSERT INTO "point_transactions" VALUES('2acb0c90-db23-4d4d-8d15-d1f3792d0b36','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','67ae1689-4ae3-42ed-9b03-549a9477fa87','2025-11-20 19:10:50');
INSERT INTO "point_transactions" VALUES('67ac8b47-8fc6-4775-a89a-80eb69a136e5','24e2e298-88c9-4a35-af04-7ff4e6631fb6',10,'video_call','67ae1689-4ae3-42ed-9b03-549a9477fa87','2025-11-20 19:10:50');
INSERT INTO "point_transactions" VALUES('ae357fad-0d17-488c-bccf-da88ef43073f','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','24b1c41a-1a40-464b-8bcd-6d6024b2dbdf','2025-11-20 19:15:44');
INSERT INTO "point_transactions" VALUES('ad7d7c02-c1d2-4034-bc33-6f0c0fa070d2','24e2e298-88c9-4a35-af04-7ff4e6631fb6',10,'video_call','24b1c41a-1a40-464b-8bcd-6d6024b2dbdf','2025-11-20 19:15:44');
INSERT INTO "point_transactions" VALUES('ee1493e0-49f9-4273-aadf-d79bb6aa34fd','24e2e298-88c9-4a35-af04-7ff4e6631fb6',10,'video_call','6e4b3836-d52b-485e-8b24-fd34a1f58acf','2025-11-20 20:36:17');
INSERT INTO "point_transactions" VALUES('3db54335-6002-426e-a564-320765b7a89f','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','6e4b3836-d52b-485e-8b24-fd34a1f58acf','2025-11-20 20:36:17');
INSERT INTO "point_transactions" VALUES('6b5ea413-9614-49c8-84cd-50599f1d51c5','24e2e298-88c9-4a35-af04-7ff4e6631fb6',10,'video_call','bc97ed46-895d-44b4-992e-f9b3f20ffd55','2025-11-20 20:54:23');
INSERT INTO "point_transactions" VALUES('cf5aa3cf-be49-409f-8163-7913a9ff083c','19cb25ff-237a-4fdf-901c-b9384a3f7e09',10,'video_call','bc97ed46-895d-44b4-992e-f9b3f20ffd55','2025-11-20 20:54:23');
