\# WhatsApp Tracker (Node.js)



Aplikasi untuk memantau status online/offline kontak WhatsApp secara real-time, lengkap dengan fitur simpan story/status dan notifikasi push. Dibangun menggunakan \[Baileys](https://github.com/WhiskeySockets/Baileys) untuk koneksi WhatsApp Web.



\## Fitur



\- Login WhatsApp via QR Code

\- Pantau status online/offline kontak secara real-time (WebSocket)

\- Tambah kontak untuk dipantau (manual via nomor WA)

\- Simpan story/status WhatsApp (foto, video, teks) dari kontak yang dipantau

\- Unduh story yang sudah tersimpan

\- Notifikasi push ke HP via \[ntfy.sh](https://ntfy.sh) saat status kontak berubah

\- REST API untuk integrasi dengan aplikasi lain



\## Persyaratan



\- \[Node.js](https://nodejs.org/) versi 18 ke atas

\- NPM (sudah termasuk saat install Node.js)

\- Nomor WhatsApp aktif untuk proses scan QR (akun yang datanya mau dipantau)



\## Instalasi



1\. Clone repository ini:

&#x20;  ```bash

&#x20;  git clone https://github.com/adityaptm/WhatsApp-Tracker-Nodejs.git

&#x20;  cd WhatsApp-Tracker-Nodejs

&#x20;  ```



2\. Install dependency:

&#x20;  ```bash

&#x20;  npm install

&#x20;  ```



3\. Salin file konfigurasi contoh, lalu sesuaikan isinya:

&#x20;  ```bash

&#x20;  cp .env.example .env

&#x20;  ```



&#x20;  Isi `.env`:

&#x20;  ```env

&#x20;  PORT=8080

&#x20;  NTFY\_TOPIC=nama-topic-ntfy-anda

&#x20;  ```



&#x20;  > Buat topic ntfy sendiri di \[ntfy.sh](https://ntfy.sh) — install app ntfy di HP, subscribe ke topic dengan nama unik (bebas, asal sulit ditebak orang lain), lalu masukkan nama topic tersebut ke `.env`.



4\. Jalankan aplikasi:

&#x20;  ```bash

&#x20;  npm start

&#x20;  ```



&#x20;  Untuk mode development (auto-restart saat ada perubahan kode):

&#x20;  ```bash

&#x20;  npm run dev

&#x20;  ```



5\. Buka `http://localhost:8080` (atau `http://\[ip-server]:8080` kalau diakses dari perangkat lain) di browser.



\## Login WhatsApp (Scan QR)



1\. Setelah aplikasi berjalan, buka `http://localhost:8080/api/qr` atau lihat QR Code yang muncul di halaman utama.

2\. Buka WhatsApp di HP → \*\*Pengaturan\*\* → \*\*Perangkat Tertaut\*\* → \*\*Tautkan Perangkat\*\*.

3\. Scan QR Code yang muncul.

4\. Setelah berhasil, sesi akan tersimpan otomatis di folder `auth\_info/` — tidak perlu scan ulang setiap restart, kecuali sesi di-logout dari HP atau folder `auth\_info/` dihapus.



> \*\*Catatan penting:\*\* WhatsApp membatasi jumlah perangkat tertaut (biasanya maksimal 4 perangkat selain HP utama). Jika limit tercapai, hapus perangkat lama yang tidak dipakai lagi melalui HP.



\## Cara Pakai



1\. Setelah login berhasil, buka halaman \*\*Select Contacts\*\* untuk melihat daftar kontak dan memilih siapa saja yang mau dipantau. Atau gunakan fitur \*\*Tambah Nomor Manual\*\* untuk menambahkan kontak lewat nomor WhatsApp langsung.

2\. Buka halaman \*\*View Status\*\* untuk melihat status online/offline kontak yang dipantau secara real-time.

3\. Buka halaman \*\*View Story\*\* untuk melihat dan mengunduh story/status yang berhasil disimpan dari kontak yang dipantau.



\## Dokumentasi REST API



Base URL: `http://localhost:8080/api`



\### `GET /api/qr`

Mendapatkan QR Code untuk login WhatsApp.



\*\*Response:\*\*

```json

{

&#x20; "qr": "data:image/png;base64,iVBORw0KGgo...",

&#x20; "status": "waiting\_qr"

}

```

Jika sudah terkoneksi, `qr` bernilai `null` dan `status` menjadi `"connected"`.



\---



\### `GET /api/status`

Mengecek status koneksi WhatsApp saat ini.



\*\*Response:\*\*

```json

{ "status": "connected" }

```

Nilai `status` bisa: `"connected"`, `"disconnected"`, atau `"waiting\_qr"`.



\---



\### `GET /api/contacts`

Mendapatkan daftar semua kontak yang tersedia dari riwayat WhatsApp.



\*\*Response:\*\*

```json

\[

&#x20; { "jid": "628123456789@s.whatsapp.net", "name": "Budi Kurniawan" }

]

```



\---



\### `POST /api/contacts/select`

Menandai kontak mana saja yang ingin dipantau statusnya.



\*\*Request Body:\*\*

```json

{ "contacts": \["628123456789@s.whatsapp.net", "628987654321@s.whatsapp.net"] }

```



\*\*Response:\*\*

```json

{ "status": "ok", "tracked": 2 }

```



\---



\### `GET /api/contacts/tracked`

Mendapatkan daftar kontak yang sedang dipantau beserta status dan riwayat online-nya.



\*\*Response:\*\*

```json

\[

&#x20; {

&#x20;   "jid": "177782067884121@lid",

&#x20;   "username": "Budi",

&#x20;   "isOnline": true,

&#x20;   "onlineRanges": \[

&#x20;     { "start": "2026-07-03T07:10:00.000Z", "end": "2026-07-03T07:15:00.000Z" }

&#x20;   ],

&#x20;   "logs": \[

&#x20;     { "time": "2026-07-03T07:10:00.000Z", "status": "Online" }

&#x20;   ]

&#x20; }

]

```



> Catatan: identitas kontak ditampilkan menggunakan LID (Linked ID), bukan nomor telepon, untuk menjaga privasi.



\---



\### `GET /api/contacts/:jid/status`

Mendapatkan status terkini dari satu kontak spesifik.



\*\*Contoh:\*\* `GET /api/contacts/177782067884121%40lid/status`



> JID mengandung karakter `@`, pastikan di-encode terlebih dahulu (`%40`) saat memanggil dari luar browser (misal lewat `curl`, Postman, atau aplikasi lain).



\---



\### `GET /api/statuses`

Mendapatkan seluruh story/status yang tersimpan dari semua kontak yang dipantau, diurutkan dari yang terbaru.



\*\*Response:\*\*

```json

\[

&#x20; {

&#x20;   "id": "ACEFE04A8BE97B2AD8CD62B10023D68C",

&#x20;   "jid": "177782067884121@lid",

&#x20;   "name": "Budi",

&#x20;   "type": "image",

&#x20;   "timestamp": "2026-07-05T15:16:48.000Z",

&#x20;   "mediaUrl": "/storage/statuses/177782067884121@lid/ACEFE04A8BE97B2AD8CD62B10023D68C.jpg"

&#x20; }

]

```



\---



\### `DELETE /api/contacts/:jid/statuses/:statusId`

Menghapus story tertentu yang sudah tersimpan.



\*\*Response:\*\*

```json

{ "status": "ok", "deleted": true }

```



\---



\### WebSocket — Update Real-Time



Selain REST API, aplikasi ini menyediakan WebSocket untuk menerima update status secara real-time tanpa perlu polling.



\*\*Endpoint:\*\* `ws://localhost:8080`



Setiap ada perubahan status kontak, server akan mengirim pesan ke semua client yang terhubung dengan format:

```json

{

&#x20; "type": "presence\_update",

&#x20; "jid": "177782067884121@lid",

&#x20; "name": "Budi",

&#x20; "isOnline": true,

&#x20; "timestamp": "2026-07-05T15:16:48.000Z"

}

```



\## Struktur Folder



```

WhatsApp-Tracker-Nodejs/

├── src/

│   ├── index.js             # Entry point (Express server + WebSocket)

│   ├── routes/

│   │   ├── api.js           # REST API endpoints

│   │   └── pages.js         # Endpoint untuk render halaman HTML

│   └── services/

│       ├── ntfy.js          # Logic notifikasi ke ntfy.sh

│       ├── state.js         # Penyimpanan state kontak \& status

│       ├── websocket.js     # WebSocket server

│       └── whatsapp.js      # Integrasi Baileys

├── public/

│   ├── select\_contacts.html # Halaman pilih kontak

│   ├── status.html          # Dashboard status real-time

│   └── view\_story.html      # Halaman lihat \& unduh story

├── storage/

│   └── statuses/            # Folder penyimpanan media story yang diunduh

├── .env.example              # Contoh konfigurasi

├── .gitignore

├── package.json

└── README.md

```



\## Catatan Keamanan \& Privasi



\- Folder `auth\_info/` berisi kredensial sesi WhatsApp — \*\*jangan pernah dibagikan atau di-commit ke Git\*\*. Sudah otomatis diabaikan lewat `.gitignore`.

\- File `.env`, `contacts\_cache.json`, dan folder `storage/statuses/` berisi data pribadi (nomor telepon, media story) — pastikan tidak ikut ter-push ke repository publik.

\- Gunakan aplikasi ini hanya untuk memantau kontak yang memang berhak/memiliki izin untuk dipantau (misal anggota keluarga sendiri), bukan untuk mengintai orang tanpa izin.

\- Topic ntfy.sh bersifat publik (siapa pun yang tahu nama topic-nya bisa membaca notifikasi) — gunakan nama topic yang unik dan sulit ditebak.



\## Troubleshooting



\*\*QR Code terus muncul berulang, tidak bisa connect\*\*

Sesi WhatsApp mungkin ter-logout dari HP. Coba scan ulang. Jika masih gagal, hapus folder `auth\_info/` dan scan dari awal.



\*\*Error `EADDRINUSE: address already in use`\*\*

Port sudah dipakai proses lain. Cari dan hentikan proses tersebut:

```bash

\# Windows

netstat -ano | findstr :8080

taskkill /PID \[PID\_YANG\_MUNCUL] /F



\# Linux/Mac

lsof -i :8080

kill -9 \[PID\_YANG\_MUNCUL]

```



\*\*Status kontak tidak berubah realtime\*\*

Pastikan kontak sudah benar-benar ter-subscribe (cek log terminal ada baris `Subscribed: ...`), dan pastikan aplikasi WhatsApp di HP kontak yang dipantau benar-benar dibuka/ditutup untuk memicu perubahan presence.



\## Lisensi



Proyek ini dibuat untuk keperluan pribadi/pembelajaran. Gunakan dengan bijak dan bertanggung jawab.

