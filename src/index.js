// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// --------------------
// MySQL (Aiven) Pool
// --------------------
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: { rejectUnauthorized: false },
});

// Corrigir __dirname (pois em ES Modules ele não existe direto)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function initDatabase() {
  try {
    // Sobe uma pasta (de /src para /)
    const sqlPath = path.join(__dirname, "../init_db.sql");
    const sql = fs.readFileSync(sqlPath, "utf8");

    console.log("🟢 Inicializando o banco de dados...");
    await pool.query(sql);
    console.log("✅ Banco de dados inicializado com sucesso!");
  } catch (err) {
    console.error("❌ Erro ao inicializar o banco de dados:", err.message);
  }
}

// Chama antes de iniciar o servidor
await initDatabase();
// --------------------
// Helpers
// --------------------
const handleError = (res, err) => {
  console.error(err);
  return res.status(500).json({ error: "Internal server error" });
};

// Simple input sanitizer for objects used with `SET ?`
// Removes undefined keys to avoid inserting them.
const clean = (obj) => {
  const out = {};
  Object.keys(obj).forEach((k) => {
    if (obj[k] !== undefined) out[k] = obj[k];
  });
  return out;
};
// Endpoint raiz para verificar status do servidor
app.get("/", (req, res) => {
  res.send("Servidor rodando");
});
// Endpoint para listar todas as tabelas do banco de dados
app.get("/tabelas", async (req, res) => {
  try {
    const [rows] = await pool.query("SHOW TABLES");
    
    // Extrai o nome das tabelas (a chave depende do nome do banco)
    const tabelas = rows.map(row => Object.values(row)[0]);
    
    res.json({
      sucesso: true,
      total: tabelas.length,
      tabelas
    });
  } catch (err) {
    console.error("Erro ao listar tabelas:", err.message);
    res.status(500).json({
      sucesso: false,
      erro: "Erro ao listar tabelas do banco de dados."
    });
  }
});
// --------------------
// Authentication (basic)
// --------------------
// NOTE: For production add JWT, sessions and stricter validation.
app.post("/auth/register", async (req, res) => {
  try {
    const { username, email, password, role = "estagiario" } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: "username, email and password required" });
    }
    const hashed = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      "INSERT INTO usuarios (username, email, password_hash, role) VALUES (?, ?, ?, ?)",
      [username, email, hashed, role]
    );
    return res.status(201).json({ id: result.insertId, username, email, role });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Email ou username já cadastrado" });
    return handleError(res, err);
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "email and password required" });
    const [rows] = await pool.query("SELECT id, username, email, password_hash, role FROM usuarios WHERE email = ?", [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Credenciais inválidas" });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Credenciais inválidas" });
    // For now return basic user info. Replace with JWT in production.
    return res.json({ id: user.id, username: user.username, email: user.email, role: user.role });
  } catch (err) {
    return handleError(res, err);
  }
});

// --------------------
// Estagiários
// --------------------
app.get("/estagiarios", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM estagiarios ORDER BY id DESC");
    res.json(rows);
  } catch (err) { handleError(res, err); }
});

app.get("/estagiarios/:id", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM estagiarios WHERE id = ?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Estagiário não encontrado" });
    res.json(rows[0]);
  } catch (err) { handleError(res, err); }
});

app.post("/estagiarios", async (req, res) => {
  try {
    const body = clean(req.body);
    // minimal required fields validation
    const required = ["nome", "data_nascimento", "genero", "numero_processo", "curso"];
    for (const f of required) if (!body[f]) return res.status(400).json({ error: `${f} é obrigatório` });

    const [result] = await pool.query("INSERT INTO estagiarios SET ?", [body]);
    const [row] = await pool.query("SELECT * FROM estagiarios WHERE id = ?", [result.insertId]);
    res.status(201).json(row[0]);
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Número de processo ou RFID duplicado" });
    handleError(res, err);
  }
});

app.put("/estagiarios/:id", async (req, res) => {
  try {
    const body = clean(req.body);
    await pool.query("UPDATE estagiarios SET ? WHERE id = ?", [body, req.params.id]);
    const [row] = await pool.query("SELECT * FROM estagiarios WHERE id = ?", [req.params.id]);
    res.json(row[0]);
  } catch (err) { handleError(res, err); }
});

app.delete("/estagiarios/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM estagiarios WHERE id = ?", [req.params.id]);
    res.json({ message: "Estagiário removido" });
  } catch (err) { handleError(res, err); }
});

app.get("/estagiarios/:id/presencas", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM presencas WHERE estagiario_id = ? ORDER BY data DESC, hora_entrada DESC", [req.params.id]);
    res.json(rows);
  } catch (err) { handleError(res, err); }
});

app.get("/estagiarios/:id/emprestimos", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT e.*, m.nome_material, m.code_id 
       FROM emprestimos e
       JOIN materiais m ON e.id_material = m.id
       WHERE e.id_estagiario = ?
       ORDER BY e.data_inicio DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { handleError(res, err); }
});

// --------------------
// Professores
// --------------------
app.get("/professores", async (req, res) => {
  try { const [rows] = await pool.query("SELECT * FROM professores ORDER BY id DESC"); res.json(rows); }
  catch (err) { handleError(res, err); }
});

app.get("/professores/:id", async (req, res) => {
  try { const [rows] = await pool.query("SELECT * FROM professores WHERE id = ?", [req.params.id]); if (!rows.length) return res.status(404).json({ error: "Professor não encontrado" }); res.json(rows[0]); }
  catch (err) { handleError(res, err); }
});

app.post("/professores", async (req, res) => {
  try {
    const body = clean(req.body);
    if (!body.nome || !body.email) return res.status(400).json({ error: "nome e email obrigatórios" });
    const [result] = await pool.query("INSERT INTO professores SET ?", [body]);
    const [row] = await pool.query("SELECT * FROM professores WHERE id = ?", [result.insertId]);
    res.status(201).json(row[0]);
  } catch (err) { handleError(res, err); }
});

app.put("/professores/:id", async (req, res) => {
  try { const body = clean(req.body); await pool.query("UPDATE professores SET ? WHERE id = ?", [body, req.params.id]); const [row] = await pool.query("SELECT * FROM professores WHERE id = ?", [req.params.id]); res.json(row[0]); }
  catch (err) { handleError(res, err); }
});

app.delete("/professores/:id", async (req, res) => {
  try { await pool.query("DELETE FROM professores WHERE id = ?", [req.params.id]); res.json({ message: "Professor removido" }); }
  catch (err) { handleError(res, err); }
});

// --------------------
// Visitas
// --------------------
app.get("/visitas", async (req, res) => {
  try { const [rows] = await pool.query("SELECT * FROM visitas ORDER BY id DESC"); res.json(rows); }
  catch (err) { handleError(res, err); }
});

app.get("/visitas/:id", async (req, res) => {
  try { const [rows] = await pool.query("SELECT * FROM visitas WHERE id = ?", [req.params.id]); if (!rows.length) return res.status(404).json({ error: "Visita não encontrada" }); res.json(rows[0]); }
  catch (err) { handleError(res, err); }
});

app.post("/visitas", async (req, res) => {
  try { const body = clean(req.body); const [result] = await pool.query("INSERT INTO visitas SET ?", [body]); const [row] = await pool.query("SELECT * FROM visitas WHERE id = ?", [result.insertId]); res.status(201).json(row[0]); }
  catch (err) { handleError(res, err); }
});

app.put("/visitas/:id", async (req, res) => {
  try { const body = clean(req.body); await pool.query("UPDATE visitas SET ? WHERE id = ?", [body, req.params.id]); const [row] = await pool.query("SELECT * FROM visitas WHERE id = ?", [req.params.id]); res.json(row[0]); }
  catch (err) { handleError(res, err); }
});

app.delete("/visitas/:id", async (req, res) => {
  try { await pool.query("DELETE FROM visitas WHERE id = ?", [req.params.id]); res.json({ message: "Visita removida" }); }
  catch (err) { handleError(res, err); }
});

// --------------------
// Materiais & Tipos
// --------------------
app.get("/materiais", async (req, res) => {
  try { const [rows] = await pool.query("SELECT m.*, t.nome_tipo FROM materiais m LEFT JOIN tipos_materiais t ON m.id_tipo_material = t.id ORDER BY m.id DESC"); res.json(rows); }
  catch (err) { handleError(res, err); }
});

app.get("/materiais/:id", async (req, res) => {
  try { const [rows] = await pool.query("SELECT * FROM materiais WHERE id = ?", [req.params.id]); if (!rows.length) return res.status(404).json({ error: "Material não encontrado" }); res.json(rows[0]); }
  catch (err) { handleError(res, err); }
});

app.post("/materiais", async (req, res) => {
  try { const body = clean(req.body); const [result] = await pool.query("INSERT INTO materiais SET ?", [body]); const [row] = await pool.query("SELECT * FROM materiais WHERE id = ?", [result.insertId]); res.status(201).json(row[0]); }
  catch (err) { handleError(res, err); }
});

app.put("/materiais/:id", async (req, res) => {
  try { const body = clean(req.body); await pool.query("UPDATE materiais SET ? WHERE id = ?", [body, req.params.id]); const [row] = await pool.query("SELECT * FROM materiais WHERE id = ?", [req.params.id]); res.json(row[0]); }
  catch (err) { handleError(res, err); }
});

app.delete("/materiais/:id", async (req, res) => {
  try { await pool.query("DELETE FROM materiais WHERE id = ?", [req.params.id]); res.json({ message: "Material removido" }); }
  catch (err) { handleError(res, err); }
});

app.get("/materiais/tipos", async (req, res) => {
  try { const [rows] = await pool.query("SELECT * FROM tipos_materiais ORDER BY id"); res.json(rows); }
  catch (err) { handleError(res, err); }
});

app.post("/materiais/tipos", async (req, res) => {
  try { const { nome_tipo } = req.body; if (!nome_tipo) return res.status(400).json({ error: "nome_tipo obrigatório" }); const [result] = await pool.query("INSERT INTO tipos_materiais (nome_tipo) VALUES (?)", [nome_tipo]); const [row] = await pool.query("SELECT * FROM tipos_materiais WHERE id = ?", [result.insertId]); res.status(201).json(row[0]); }
  catch (err) { handleError(res, err); }
});

// --------------------
// Empréstimos
// --------------------
app.get("/emprestimos", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT e.*, m.nome_material, m.code_id, est.nome AS estagiario_nome
       FROM emprestimos e
       LEFT JOIN materiais m ON e.id_material = m.id
       LEFT JOIN estagiarios est ON e.id_estagiario = est.id
       ORDER BY e.data_inicio DESC`
    );
    res.json(rows);
  } catch (err) { handleError(res, err); }
});

app.get("/emprestimos/:id", async (req, res) => {
  try { const [rows] = await pool.query("SELECT * FROM emprestimos WHERE id = ?", [req.params.id]); if (!rows.length) return res.status(404).json({ error: "Empréstimo não encontrado" }); res.json(rows[0]); }
  catch (err) { handleError(res, err); }
});

app.post("/emprestimos", async (req, res) => {
  try {
    const body = clean(req.body);
    if (!body.id_material || (!body.id_estagiario && !body.id_visita) || !body.data_inicio) {
      return res.status(400).json({ error: "id_material, id_estagiario|id_visita e data_inicio obrigatórios" });
    }
    const [result] = await pool.query("INSERT INTO emprestimos SET ?", [body]);
    const [row] = await pool.query("SELECT * FROM emprestimos WHERE id = ?", [result.insertId]);
    res.status(201).json(row[0]);
  } catch (err) { handleError(res, err); }
});

app.put("/emprestimos/:id", async (req, res) => {
  try { const body = clean(req.body); await pool.query("UPDATE emprestimos SET ? WHERE id = ?", [body, req.params.id]); const [row] = await pool.query("SELECT * FROM emprestimos WHERE id = ?", [req.params.id]); res.json(row[0]); }
  catch (err) { handleError(res, err); }
});

app.delete("/emprestimos/:id", async (req, res) => {
  try { await pool.query("DELETE FROM emprestimos WHERE id = ?", [req.params.id]); res.json({ message: "Empréstimo cancelado" }); }
  catch (err) { handleError(res, err); }
});

// --------------------
// Presenças
// --------------------
app.get("/presencas", async (req, res) => {
  try { const [rows] = await pool.query("SELECT p.*, e.nome as estagiario_nome FROM presencas p LEFT JOIN estagiarios e ON p.estagiario_id = e.id ORDER BY p.data DESC, p.hora_entrada DESC"); res.json(rows); }
  catch (err) { handleError(res, err); }
});

app.get("/presencas/:estagiarioId", async (req, res) => {
  try { const [rows] = await pool.query("SELECT * FROM presencas WHERE estagiario_id = ? ORDER BY data DESC", [req.params.estagiarioId]); res.json(rows); }
  catch (err) { handleError(res, err); }
});

app.post("/presencas", async (req, res) => {
  try {
    const { estagiario_id, data, hora_entrada, hora_saida } = req.body;
    if (!estagiario_id || !data) return res.status(400).json({ error: "estagiario_id e data obrigatórios" });
    const [result] = await pool.query("INSERT INTO presencas (estagiario_id, data, hora_entrada, hora_saida) VALUES (?, ?, ?, ?)", [estagiario_id, data, hora_entrada || null, hora_saida || null]);
    const [row] = await pool.query("SELECT * FROM presencas WHERE id = ?", [result.insertId]);
    res.status(201).json(row[0]);
  } catch (err) { handleError(res, err); }
});

// --------------------
// Relatórios
// --------------------
app.get("/relatorios", async (req, res) => {
  try { const [rows] = await pool.query("SELECT * FROM relatorios ORDER BY id DESC"); res.json(rows); }
  catch (err) { handleError(res, err); }
});

app.get("/relatorios/:id", async (req, res) => {
  try { const [rows] = await pool.query("SELECT * FROM relatorios WHERE id = ?", [req.params.id]); if (!rows.length) return res.status(404).json({ error: "Relatório não encontrado" }); res.json(rows[0]); }
  catch (err) { handleError(res, err); }
});

app.post("/relatorios", async (req, res) => {
  try { const body = clean(req.body); if (!body.estagiario_id || !body.titulo || !body.conteudo) return res.status(400).json({ error: "estagiario_id, titulo e conteudo obrigatórios" }); const [result] = await pool.query("INSERT INTO relatorios SET ?", [body]); const [row] = await pool.query("SELECT * FROM relatorios WHERE id = ?", [result.insertId]); res.status(201).json(row[0]); }
  catch (err) { handleError(res, err); }
});

app.put("/relatorios/:id", async (req, res) => {
  try { const body = clean(req.body); await pool.query("UPDATE relatorios SET ? WHERE id = ?", [body, req.params.id]); const [row] = await pool.query("SELECT * FROM relatorios WHERE id = ?", [req.params.id]); res.json(row[0]); }
  catch (err) { handleError(res, err); }
});

app.delete("/relatorios/:id", async (req, res) => {
  try { await pool.query("DELETE FROM relatorios WHERE id = ?", [req.params.id]); res.json({ message: "Relatório removido" }); }
  catch (err) { handleError(res, err); }
});

// --------------------
// Dashboard / Estatísticas simples
// --------------------
app.get("/dashboard", async (req, res) => {
  try {
    const [[{ total_estagiarios }]] = await pool.query("SELECT COUNT(*) AS total_estagiarios FROM estagiarios");
    const [[{ total_materiais }]] = await pool.query("SELECT COUNT(*) AS total_materiais FROM materiais");
    const [[{ emprestimos_abertos }]] = await pool.query("SELECT COUNT(*) AS emprestimos_abertos FROM emprestimos WHERE status = 'Em uso'");
    res.json({ total_estagiarios, total_materiais, emprestimos_abertos });
  } catch (err) { handleError(res, err); }
});

// --------------------
// Start server
// --------------------
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
app.listen(PORT, () => console.log(`Smart Lab API rodando na porta ${PORT}`));
