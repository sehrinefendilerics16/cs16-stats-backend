const express = require("express");
const app = express();

app.use(express.json());

app.post("/data", (req, res) => {
    console.log("GELEN VERİ:", req.body);
    res.send("OK");
});

app.get("/", (req, res) => {
    res.send("SERVER CALISIYOR");
});

app.listen(3000, () => {
    console.log("Server calisiyor");
});
