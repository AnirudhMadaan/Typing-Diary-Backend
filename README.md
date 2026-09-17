# Typing Diary backend

This folder contains the standalone Express API used by the HTML/CSS/JS frontend.

## Run

```bash
cd backend
npm install
SESSION_SECRET="replace-with-a-long-random-value" npm start
```

The API runs on `http://localhost:8080` by default. Set `PORT` to change it.

The data file is created at `backend/data/typing-diary.json`. Set `DATA_DIR` to move it.