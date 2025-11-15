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
  multipleStatements: true,
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

// Helper para formatar UID (remove espaços e padroniza)
const formatarUID = (uid) => {
  if (!uid) return '';
  // Remove espaços e converte para maiúsculas
  return uid.replace(/\s/g, '').toUpperCase();
};

// ====================
// ENDPOINTS GERAIS
// ====================

// Endpoint raiz para verificar status do servidor
app.get("/", (req, res) => {
  res.json({ 
    mensagem: "Smart Lab API rodando", 
    timestamp: new Date().toISOString(),
    versao: "2.0",
    recursos: ["RFID", "Estagiários", "Professores", "Materiais", "Empréstimos", "Presenças"]
  });
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

// ====================
// ENDPOINTS RFID - INTEGRAÇÃO COM ESP32
// ====================

// Endpoint para verificar acesso por RFID
app.post("/rfid/verificar-acesso", async (req, res) => {
  try {
    const { uid } = req.body;
    
    if (!uid) {
      return res.status(400).json({
        sucesso: false,
        acesso: "NEGADO",
        mensagem: "UID não fornecido"
      });
    }

    const uidFormatado = formatarUID(uid);
    console.log(`🔍 Verificando acesso para UID: ${uidFormatado}`);

    // Buscar estagiário pelo RFID
    const [estagiarios] = await pool.query(
      "SELECT id, nome, email, numero_processo, curso, foto FROM estagiarios WHERE rfid_uid = ?",
      [uidFormatado]
    );

    if (estagiarios.length > 0) {
      const estagiario = estagiarios[0];
      
      // Registrar presença automaticamente
      const hoje = new Date().toISOString().split('T')[0];
      const horaAtual = new Date().toLocaleTimeString('pt-BR', { hour12: false });
      
      // Verificar se já existe registro de presença hoje
      const [presencas] = await pool.query(
        "SELECT * FROM presencas WHERE estagiario_id = ? AND data = ?",
        [estagiario.id, hoje]
      );

      if (presencas.length === 0) {
        // Primeira entrada do dia - registrar entrada
        await pool.query(
          "INSERT INTO presencas (estagiario_id, data, hora_entrada) VALUES (?, ?, ?)",
          [estagiario.id, hoje, horaAtual]
        );
        
        console.log(`✅ Entrada registrada para: ${estagiario.nome}`);
        
        return res.json({
          sucesso: true,
          acesso: "LIBERADO",
          tipo: "ENTRADA",
          mensagem: `Bem-vindo(a), ${estagiario.nome}!`,
          estagiario: {
            id: estagiario.id,
            nome: estagiario.nome,
            curso: estagiario.curso,
            foto: estagiario.foto
          },
          horario: horaAtual
        });
        
      } else {
        const presenca = presencas[0];
        
        if (!presenca.hora_saida) {
          // Registrar saída
          await pool.query(
            "UPDATE presencas SET hora_saida = ? WHERE id = ?",
            [horaAtual, presenca.id]
          );
          
          console.log(`✅ Saída registrada para: ${estagiario.nome}`);
          
          return res.json({
            sucesso: true,
            acesso: "LIBERADO",
            tipo: "SAIDA",
            mensagem: `Até logo, ${estagiario.nome}!`,
            estagiario: {
              id: estagiario.id,
              nome: estagiario.nome,
              curso: estagiario.curso,
              foto: estagiario.foto
            },
            horario: horaAtual
          });
        } else {
          // Já registrou entrada e saída hoje
          return res.json({
            sucesso: true,
            acesso: "LIBERADO",
            tipo: "CONSULTA",
            mensagem: `Olá ${estagiario.nome}! Já registrou presença hoje.`,
            estagiario: {
              id: estagiario.id,
              nome: estagiario.nome,
              curso: estagiario.curso,
              foto: estagiario.foto
            }
          });
        }
      }
    } else {
      // UID não encontrado
      console.log(`❌ Acesso negado para UID: ${uidFormatado}`);
      
      return res.json({
        sucesso: false,
        acesso: "NEGADO",
        mensagem: "Cartão não cadastrado no sistema",
        uid: uidFormatado
      });
    }
  } catch (err) {
    console.error("Erro ao verificar acesso RFID:", err);
    return res.status(500).json({
      sucesso: false,
      acesso: "NEGADO",
      mensagem: "Erro interno do servidor"
    });
  }
});

// Endpoint para cadastrar novo cartão RFID
app.post("/rfid/cadastrar-cartao", async (req, res) => {
  try {
    const { uid, estagiario_id, nome } = req.body;
    
    if (!uid) {
      return res.status(400).json({
        sucesso: false,
        mensagem: "UID do cartão não fornecido"
      });
    }

    const uidFormatado = formatarUID(uid);

    // Verificar se o UID já está em uso
    const [uidExistente] = await pool.query(
      "SELECT id, nome FROM estagiarios WHERE rfid_uid = ?",
      [uidFormatado]
    );

    if (uidExistente.length > 0) {
      return res.status(409).json({
        sucesso: false,
        mensagem: `Cartão já está cadastrado para: ${uidExistente[0].nome}`,
        estagiario: uidExistente[0]
      });
    }

    if (estagiario_id) {
      // Associar cartão a estagiário existente
      const [result] = await pool.query(
        "UPDATE estagiarios SET rfid_uid = ? WHERE id = ?",
        [uidFormatado, estagiario_id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          sucesso: false,
          mensagem: "Estagiário não encontrado"
        });
      }

      // Buscar dados atualizados do estagiário
      const [estagiario] = await pool.query(
        "SELECT id, nome, rfid_uid FROM estagiarios WHERE id = ?",
        [estagiario_id]
      );

      console.log(`✅ Cartão cadastrado para: ${estagiario[0].nome}`);
      
      return res.json({
        sucesso: true,
        mensagem: `Cartão cadastrado com sucesso para ${estagiario[0].nome}`,
        estagiario: estagiario[0]
      });
      
    } else if (nome) {
      // Criar novo estagiário com o cartão
      const numeroProcesso = `PROC-${Date.now()}`;
      const email = `${nome.toLowerCase().replace(/\s/g, '.')}@smartlab.com`;
      const senhaPadrao = "123456";
      
      const hashed = await bcrypt.hash(senhaPadrao, 10);
      
      const [result] = await pool.query(
        "INSERT INTO estagiarios (nome, email, password_hash, rfid_uid, numero_processo, curso, genero, data_nascimento) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [nome, email, hashed, uidFormatado, numeroProcesso, "A definir", "A definir", "2000-01-01"]
      );

      const [novoEstagiario] = await pool.query(
        "SELECT id, nome, rfid_uid FROM estagiarios WHERE id = ?",
        [result.insertId]
      );

      console.log(`✅ Novo estagiário criado: ${nome} com cartão RFID`);
      
      return res.json({
        sucesso: true,
        mensagem: `Estagiário ${nome} criado com cartão RFID`,
        estagiario: novoEstagiario[0]
      });
    } else {
      return res.status(400).json({
        sucesso: false,
        mensagem: "Forneça estagiario_id ou nome para cadastrar o cartão"
      });
    }
  } catch (err) {
    console.error("Erro ao cadastrar cartão RFID:", err);
    return res.status(500).json({
      sucesso: false,
      mensagem: "Erro interno do servidor"
    });
  }
});

// Endpoint para listar cartões RFID cadastrados
app.get("/rfid/cartoes", async (req, res) => {
  try {
    const [cartoes] = await pool.query(
      `SELECT id, nome, rfid_uid, numero_processo, curso, 
              (SELECT COUNT(*) FROM presencas WHERE estagiario_id = estagiarios.id) as total_presencas
       FROM estagiarios 
       WHERE rfid_uid IS NOT NULL AND rfid_uid != ''
       ORDER BY nome`
    );

    res.json({
      sucesso: true,
      total: cartoes.length,
      cartoes
    });
  } catch (err) {
    console.error("Erro ao listar cartões RFID:", err);
    return res.status(500).json({
      sucesso: false,
      mensagem: "Erro interno do servidor"
    });
  }
});

// Endpoint para remover associação de cartão RFID
app.delete("/rfid/cartoes/:estagiario_id", async (req, res) => {
  try {
    const { estagiario_id } = req.params;
    
    const [result] = await pool.query(
      "UPDATE estagiarios SET rfid_uid = NULL WHERE id = ?",
      [estagiario_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Estagiário não encontrado ou sem cartão associado"
      });
    }

    res.json({
      sucesso: true,
      mensagem: "Cartão RFID removido com sucesso"
    });
  } catch (err) {
    console.error("Erro ao remover cartão RFID:", err);
    return res.status(500).json({
      sucesso: false,
      mensagem: "Erro interno do servidor"
    });
  }
});

// Endpoint para histórico de acessos RFID
app.get("/rfid/historico", async (req, res) => {
  try {
    const { limite = 50 } = req.query;
    
    const [historico] = await pool.query(
      `SELECT p.*, e.nome, e.rfid_uid, e.curso
       FROM presencas p
       JOIN estagiarios e ON p.estagiario_id = e.id
       WHERE e.rfid_uid IS NOT NULL
       ORDER BY p.data DESC, p.hora_entrada DESC
       LIMIT ?`,
      [parseInt(limite)]
    );

    res.json({
      sucesso: true,
      total: historico.length,
      historico
    });
  } catch (err) {
    console.error("Erro ao buscar histórico RFID:", err);
    return res.status(500).json({
      sucesso: false,
      mensagem: "Erro interno do servidor"
    });
  }
});

// Endpoint simples para teste do ESP32
app.get("/rfid/status", (req, res) => {
  res.json({
    sucesso: true,
    mensagem: "Sistema RFID online",
    timestamp: new Date().toISOString(),
    versao: "1.0"
  });
});

// ====================
// AUTENTICAÇÃO
// ====================

app.post("/auth/register", async (req, res) => {
  try {
    const { username, email, password, role = "estagiario", genero } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: "username, email and password required" });
    }

    if (role === "estagiario") {
      return res.status(400).json({ error: "Use /estagiarios para cadastrar estagiários com perfil completo" });
    }

    if (role === "professor") {
      if (!genero) return res.status(400).json({ error: "genero é obrigatório para professor" });
      const hashed = await bcrypt.hash(password, 10);
      const foto = req.body.foto || req.body.fotoPerfil || null;
      try {
        const [result] = await pool.query(
          "INSERT INTO professores (nome, genero, email, password_hash, foto) VALUES (?, ?, ?, ?, ?)",
          [username, genero, email, hashed, foto]
        );
        return res.status(201).json({ id: result.insertId, nome: username, email, role });
      } catch (err) {
        if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Email já cadastrado" });
        return handleError(res, err);
      }
    }

    return res.status(400).json({ error: "role inválida" });
  } catch (err) {
    return handleError(res, err);
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "email and password required" });
    
    // Try professores first
    const [profRows] = await pool.query("SELECT id, nome, email, password_hash FROM professores WHERE email = ?", [email]);
    if (profRows.length) {
      const prof = profRows[0];
      const ok = await bcrypt.compare(password, prof.password_hash);
      if (!ok) return res.status(401).json({ error: "Credenciais inválidas" });
      return res.json({ id: prof.id, username: prof.nome, email: prof.email, role: "professor" });
    }

    // Then try estagiarios
    const [estRows] = await pool.query("SELECT id, nome, email, password_hash FROM estagiarios WHERE email = ?", [email]);
    if (estRows.length) {
      const est = estRows[0];
      const ok = await bcrypt.compare(password, est.password_hash);
      if (!ok) return res.status(401).json({ error: "Credenciais inválidas" });
      return res.json({ id: est.id, username: est.nome, email: est.email, role: "estagiario" });
    }

    return res.status(401).json({ error: "Credenciais inválidas" });
  } catch (err) {
    return handleError(res, err);
  }
});

// ====================
// ESTAGIÁRIOS
// ====================

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
    if (body.fotoPerfil) {
      body.foto = body.fotoPerfil;
      delete body.fotoPerfil;
    }
    
    const required = ["nome", "data_nascimento", "genero", "numero_processo", "curso", "password"];
    for (const f of required) if (!body[f]) return res.status(400).json({ error: `${f} é obrigatório` });

    if (body.password) {
      try {
        const hashed = await bcrypt.hash(body.password, 10);
        body.password_hash = hashed;
      } catch (hashErr) {
        console.error('Erro ao hashar senha do estagiário', hashErr);
        return res.status(500).json({ error: 'Erro interno ao processar senha' });
      }
      delete body.password;
    }

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
    if (body.fotoPerfil) {
      body.foto = body.fotoPerfil;
      delete body.fotoPerfil;
    }
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

// ====================
// PROFESSORES
// ====================

app.get("/professores", async (req, res) => {
  try { 
    const [rows] = await pool.query("SELECT * FROM professores ORDER BY id DESC"); 
    res.json(rows); 
  } catch (err) { handleError(res, err); }
});

app.get("/professores/:id", async (req, res) => {
  try { 
    const [rows] = await pool.query("SELECT * FROM professores WHERE id = ?", [req.params.id]); 
    if (!rows.length) return res.status(404).json({ error: "Professor não encontrado" }); 
    res.json(rows[0]); 
  } catch (err) { handleError(res, err); }
});

app.post("/professores", async (req, res) => {
  try {
    const body = clean(req.body);
    if (body.fotoPerfil) {
      body.foto = body.fotoPerfil;
      delete body.fotoPerfil;
    }
    if (!body.nome || !body.email) return res.status(400).json({ error: "nome e email obrigatórios" });
    const [result] = await pool.query("INSERT INTO professores SET ?", [body]);
    const [row] = await pool.query("SELECT * FROM professores WHERE id = ?", [result.insertId]);
    res.status(201).json(row[0]);
  } catch (err) { handleError(res, err); }
});

app.put("/professores/:id", async (req, res) => {
  try { 
    const body = clean(req.body); 
    await pool.query("UPDATE professores SET ? WHERE id = ?", [body, req.params.id]); 
    const [row] = await pool.query("SELECT * FROM professores WHERE id = ?", [req.params.id]); 
    res.json(row[0]); 
  } catch (err) { handleError(res, err); }
});

app.delete("/professores/:id", async (req, res) => {
  try { 
    await pool.query("DELETE FROM professores WHERE id = ?", [req.params.id]); 
    res.json({ message: "Professor removido" }); 
  } catch (err) { handleError(res, err); }
});

// ====================
// VISITAS
// ====================

app.get("/visitas", async (req, res) => {
  try { 
    const [rows] = await pool.query("SELECT * FROM visitas ORDER BY id DESC"); 
    res.json(rows); 
  } catch (err) { handleError(res, err); }
});

app.get("/visitas/:id", async (req, res) => {
  try { 
    const [rows] = await pool.query("SELECT * FROM visitas WHERE id = ?", [req.params.id]); 
    if (!rows.length) return res.status(404).json({ error: "Visita não encontrada" }); 
    res.json(rows[0]); 
  } catch (err) { handleError(res, err); }
});

app.post("/visitas", async (req, res) => {
  try { 
    const body = clean(req.body); 
    const [result] = await pool.query("INSERT INTO visitas SET ?", [body]); 
    const [row] = await pool.query("SELECT * FROM visitas WHERE id = ?", [result.insertId]); 
    res.status(201).json(row[0]); 
  } catch (err) { handleError(res, err); }
});

app.put("/visitas/:id", async (req, res) => {
  try { 
    const body = clean(req.body); 
    await pool.query("UPDATE visitas SET ? WHERE id = ?", [body, req.params.id]); 
    const [row] = await pool.query("SELECT * FROM visitas WHERE id = ?", [req.params.id]); 
    res.json(row[0]); 
  } catch (err) { handleError(res, err); }
});

app.delete("/visitas/:id", async (req, res) => {
  try { 
    await pool.query("DELETE FROM visitas WHERE id = ?", [req.params.id]); 
    res.json({ message: "Visita removida" }); 
  } catch (err) { handleError(res, err); }
});

// ====================
// MATERIAIS & TIPOS
// ====================

app.get("/materiais", async (req, res) => {
  try { 
    const [rows] = await pool.query("SELECT m.*, t.nome_tipo FROM materiais m LEFT JOIN tipos_materiais t ON m.id_tipo_material = t.id ORDER BY m.id DESC"); 
    res.json(rows); 
  } catch (err) { handleError(res, err); }
});

app.get("/materiais/:id", async (req, res) => {
  try { 
    const [rows] = await pool.query("SELECT * FROM materiais WHERE id = ?", [req.params.id]); 
    if (!rows.length) return res.status(404).json({ error: "Material não encontrado" }); 
    res.json(rows[0]); 
  } catch (err) { handleError(res, err); }
});

app.post("/materiais", async (req, res) => {
  try { 
    const body = clean(req.body); 
    const [result] = await pool.query("INSERT INTO materiais SET ?", [body]); 
    const [row] = await pool.query("SELECT * FROM materiais WHERE id = ?", [result.insertId]); 
    res.status(201).json(row[0]); 
  } catch (err) { handleError(res, err); }
});

app.put("/materiais/:id", async (req, res) => {
  try { 
    const body = clean(req.body); 
    await pool.query("UPDATE materiais SET ? WHERE id = ?", [body, req.params.id]); 
    const [row] = await pool.query("SELECT * FROM materiais WHERE id = ?", [req.params.id]); 
    res.json(row[0]); 
  } catch (err) { handleError(res, err); }
});

app.delete("/materiais/:id", async (req, res) => {
  try { 
    await pool.query("DELETE FROM materiais WHERE id = ?", [req.params.id]); 
    res.json({ message: "Material removido" }); 
  } catch (err) { handleError(res, err); }
});

app.get("/materiais/tipos", async (req, res) => {
  try { 
    const [rows] = await pool.query("SELECT * FROM tipos_materiais ORDER BY id"); 
    res.json(rows); 
  } catch (err) { handleError(res, err); }
});

app.post("/materiais/tipos", async (req, res) => {
  try { 
    const { nome_tipo } = req.body; 
    if (!nome_tipo) return res.status(400).json({ error: "nome_tipo obrigatório" }); 
    const [result] = await pool.query("INSERT INTO tipos_materiais (nome_tipo) VALUES (?)", [nome_tipo]); 
    const [row] = await pool.query("SELECT * FROM tipos_materiais WHERE id = ?", [result.insertId]); 
    res.status(201).json(row[0]); 
  } catch (err) { handleError(res, err); }
});

// ====================
// EMPRÉSTIMOS
// ====================

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
  try { 
    const [rows] = await pool.query("SELECT * FROM emprestimos WHERE id = ?", [req.params.id]); 
    if (!rows.length) return res.status(404).json({ error: "Empréstimo não encontrado" }); 
    res.json(rows[0]); 
  } catch (err) { handleError(res, err); }
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
  try { 
    const body = clean(req.body); 
    await pool.query("UPDATE emprestimos SET ? WHERE id = ?", [body, req.params.id]); 
    const [row] = await pool.query("SELECT * FROM emprestimos WHERE id = ?", [req.params.id]); 
    res.json(row[0]); 
  } catch (err) { handleError(res, err); }
});

app.delete("/emprestimos/:id", async (req, res) => {
  try { 
    await pool.query("DELETE FROM emprestimos WHERE id = ?", [req.params.id]); 
    res.json({ message: "Empréstimo cancelado" }); 
  } catch (err) { handleError(res, err); }
});

// ====================
// PRESENÇAS
// ====================

app.get("/presencas", async (req, res) => {
  try { 
    const [rows] = await pool.query("SELECT p.*, e.nome as estagiario_nome FROM presencas p LEFT JOIN estagiarios e ON p.estagiario_id = e.id ORDER BY p.data DESC, p.hora_entrada DESC"); 
    res.json(rows); 
  } catch (err) { handleError(res, err); }
});

app.get("/presencas/:estagiarioId", async (req, res) => {
  try { 
    const [rows] = await pool.query("SELECT * FROM presencas WHERE estagiario_id = ? ORDER BY data DESC", [req.params.estagiarioId]); 
    res.json(rows); 
  } catch (err) { handleError(res, err); }
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

// ====================
// RELATÓRIOS
// ====================

app.get("/relatorios", async (req, res) => {
  try { 
    const [rows] = await pool.query("SELECT * FROM relatorios ORDER BY id DESC"); 
    res.json(rows); 
  } catch (err) { handleError(res, err); }
});

app.get("/relatorios/:id", async (req, res) => {
  try { 
    const [rows] = await pool.query("SELECT * FROM relatorios WHERE id = ?", [req.params.id]); 
    if (!rows.length) return res.status(404).json({ error: "Relatório não encontrado" }); 
    res.json(rows[0]); 
  } catch (err) { handleError(res, err); }
});

app.post("/relatorios", async (req, res) => {
  try { 
    const body = clean(req.body); 
    if (!body.estagiario_id || !body.titulo || !body.conteudo) return res.status(400).json({ error: "estagiario_id, titulo e conteudo obrigatórios" }); 
    const [result] = await pool.query("INSERT INTO relatorios SET ?", [body]); 
    const [row] = await pool.query("SELECT * FROM relatorios WHERE id = ?", [result.insertId]); 
    res.status(201).json(row[0]); 
  } catch (err) { handleError(res, err); }
});

app.put("/relatorios/:id", async (req, res) => {
  try { 
    const body = clean(req.body); 
    await pool.query("UPDATE relatorios SET ? WHERE id = ?", [body, req.params.id]); 
    const [row] = await pool.query("SELECT * FROM relatorios WHERE id = ?", [req.params.id]); 
    res.json(row[0]); 
  } catch (err) { handleError(res, err); }
});

app.delete("/relatorios/:id", async (req, res) => {
  try { 
    await pool.query("DELETE FROM relatorios WHERE id = ?", [req.params.id]); 
    res.json({ message: "Relatório removido" }); 
  } catch (err) { handleError(res, err); }
});

// ====================
// DASHBOARD & ESTATÍSTICAS
// ====================

app.get("/dashboard", async (req, res) => {
  try {
    const [[{ total_estagiarios }]] = await pool.query("SELECT COUNT(*) AS total_estagiarios FROM estagiarios");
    const [[{ total_materiais }]] = await pool.query("SELECT COUNT(*) AS total_materiais FROM materiais");
    const [[{ emprestimos_abertos }]] = await pool.query("SELECT COUNT(*) AS emprestimos_abertos FROM emprestimos WHERE status = 'Em uso'");
    
    // Estatísticas RFID
    const [[{ total_cartoes }]] = await pool.query("SELECT COUNT(*) AS total_cartoes FROM estagiarios WHERE rfid_uid IS NOT NULL AND rfid_uid != ''");
    const [[{ acessos_hoje }]] = await pool.query("SELECT COUNT(*) AS acessos_hoje FROM presencas WHERE data = CURDATE()");
    
    res.json({ 
      total_estagiarios, 
      total_materiais, 
      emprestimos_abertos,
      total_cartoes,
      acessos_hoje
    });
  } catch (err) { handleError(res, err); }
});

// ====================
// ADMIN & MIGRAÇÃO
// ====================

app.post('/admin/migrate/foto-columns', async (req, res) => {
  try {
    if (process.env.ALLOW_MIGRATE !== 'true') return res.status(403).json({ error: 'Migration not allowed' });
    await pool.query('ALTER TABLE professores MODIFY foto LONGTEXT; ALTER TABLE estagiarios MODIFY foto LONGTEXT;');
    return res.json({ ok: true, message: 'Migration executed' });
  } catch (err) {
    console.error('Migration error', err);
    return res.status(500).json({ error: 'Migration failed', details: err.message });
  }
});

// ====================
// INICIAR SERVIDOR
// ====================

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
app.listen(PORT, () => {
  console.log(`🚀 Smart Lab API rodando na porta ${PORT}`);
  console.log(`📡 Endpoints RFID disponíveis:`);
  console.log(`   POST /rfid/verificar-acesso     - Verificar acesso e registrar presença`);
  console.log(`   POST /rfid/cadastrar-cartao     - Cadastrar novo cartão RFID`);
  console.log(`   GET  /rfid/cartoes              - Listar cartões cadastrados`);
  console.log(`   GET  /rfid/historico            - Histórico de acessos`);
  console.log(`   GET  /rfid/status               - Status do sistema`);
  console.log(`   DELETE /rfid/cartoes/:id        - Remover cartão`);
  console.log(`🔗 Total de endpoints: 40+`);
});
