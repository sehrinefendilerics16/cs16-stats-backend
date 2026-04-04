const express = require("express");
const app = express();

app.use(express.json());

// Veri alma endpointi
app.post("/data", (req, res) => {
  console.log("GELEN VERİ:", req.body);
  res.send("OK");
});

// Test endpointi
app.get("/", (req, res) => {
  res.send("SERVER CALISIYOR");
});

// PORT fix (KRİTİK)
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server calisiyor, port:", PORT);
});
