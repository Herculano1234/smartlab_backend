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

// --------------------
// Authentication (basic) - CONTINUA...
// (Mantém todo o código original abaixo)
// --------------------

// NOTE: For production add JWT, sessions and stricter validation.
// Register endpoint: create a professor (administrative) or instruct to use /estagiarios
app.post("/auth/register", async (req, res) => {
  try {
    const { username, email, password, role = "estagiario", genero } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: "username, email and password required" });
    }

    if (role === "estagiario") {
      // estagiários should be created via /estagiarios which expects full profile data
      return res.status(400).json({ error: "Use /estagiarios para cadastrar estagiários com perfil completo" });
    }

    if (role === "professor") {
      // For professor creation require genero as it's NOT NULL in schema
      if (!genero) return res.status(400).json({ error: "genero é obrigatório para professor" });
      const hashed = await bcrypt.hash(password, 10);
      // allow optional photo
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

// ... (MANTÉM TODOS OS OUTROS ENDPOINTS ORIGINAIS)
// [Todo o restante do código original permanece igual]

// --------------------
// Start server
// --------------------
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
app.listen(PORT, () => {
  console.log(`Smart Lab API rodando na porta ${PORT}`);
  console.log(`📡 Endpoints RFID disponíveis:`);
  console.log(`   POST /rfid/verificar-acesso`);
  console.log(`   POST /rfid/cadastrar-cartao`);
  console.log(`   GET  /rfid/cartoes`);
  console.log(`   GET  /rfid/historico`);
  console.log(`   GET  /rfid/status`);
});
