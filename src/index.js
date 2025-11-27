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
let lastRfidCode = null; // variável em memória que guarda o último código

// Endpoint que o ESP32 chama para enviar o código RFID
app.post('/rfid', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code é obrigatório' });

  lastRfidCode = code;
  console.log('RFID recebido:', code);
  return res.json({ ok: true });
});

// Endpoint que o frontend chama para obter o último código
app.get('/rfid', (req, res) => {
  return res.json({ code: lastRfidCode });
});
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

// ==================== ENDPOINTS RFID ====================
// Endpoint para verificar status da API (ESP32)
app.get("/rfid/status", (req, res) => {
  res.json({
    status: "online",
    message: "API Smart Lab RFID funcionando",
    timestamp: new Date().toISOString()
  });
});

// Endpoint principal para verificar acesso via RFID
app.post("/rfid/verificar-acesso", async (req, res) => {
  try {
    const { uid } = req.body;
   
    if (!uid) {
      return res.json({
        sucesso: false,
        acesso: "NEGADO",
        mensagem: "UID não fornecido"
      });
    }

    console.log(`🔍 Verificando acesso para UID: ${uid}`);

    // Busca estagiário pelo UID (corrigido para usar codigo_rfid)
    const [estagiarios] = await pool.query(
      "SELECT id, nome, email, numero_processo, curso FROM estagiarios WHERE codigo_rfid = ?",
      [uid.trim()]
    );

    if (estagiarios.length === 0) {
      return res.json({
        sucesso: false,
        acesso: "NEGADO",
        mensagem: "Cartão não cadastrado no sistema"
      });
    }

    const estagiario = estagiarios[0];
    const hoje = new Date().toISOString().split('T')[0];
    const agora = new Date().toTimeString().split(' ')[0];

    // Verifica se já existe registro de presença hoje
    const [presencas] = await pool.query(
      "SELECT * FROM presencas WHERE estagiario_id = ? AND data = ? ORDER BY id DESC LIMIT 1",
      [estagiario.id, hoje]
    );

    let tipo = "";
    let horario = "";

    if (presencas.length === 0) {
      // Primeira entrada do dia - ENTRADA
      tipo = "ENTRADA";
      await pool.query(
        "INSERT INTO presencas (estagiario_id, data, hora_entrada) VALUES (?, ?, ?)",
        [estagiario.id, hoje, agora]
      );
      horario = agora;
    } else {
      const ultimaPresenca = presencas[0];
     
      if (!ultimaPresenca.hora_saida) {
        // Tem entrada mas não tem saída - SAÍDA
        tipo = "SAIDA";
        await pool.query(
          "UPDATE presencas SET hora_saida = ? WHERE id = ?",
          [agora, ultimaPresenca.id]
        );
        horario = agora;
      } else {
        // Já registrou entrada e saída hoje - não faz nada
        return res.json({
          sucesso: false,
          acesso: "NEGADO",
          mensagem: "Já registrou entrada e saída hoje"
        });
      }
    }

    console.log(`✅ Acesso ${tipo} registrado para: ${estagiario.nome}`);

    res.json({
      sucesso: true,
      acesso: "LIBERADO",
      mensagem: `Acesso autorizado - ${tipo}`,
      tipo: tipo,
      horario: horario,
      estagiario: {
        id: estagiario.id,
        nome: estagiario.nome,
        numero_processo: estagiario.numero_processo,
        curso: estagiario.curso
      }
    });

  } catch (err) {
    console.error("❌ Erro no endpoint RFID:", err);
    res.status(500).json({
      sucesso: false,
      acesso: "NEGADO",
      mensagem: "Erro interno do servidor"
    });
  }
});

// Endpoint para registrar presença manualmente (via sistema web)
app.post("/presencas/registrar", async (req, res) => {
  try {
    const { uid, tipo } = req.body;
   
    if (!uid) {
      return res.status(400).json({
        sucesso: false,
        mensagem: "UID do cartão RFID é obrigatório"
      });
    }

    console.log(`📝 Registrando presença manual para UID: ${uid}, Tipo: ${tipo}`);

    // Busca estagiário pelo UID (corrigido para usar codigo_rfid)
    const [estagiarios] = await pool.query(
      "SELECT id, nome, email, numero_processo, curso FROM estagiarios WHERE codigo_rfid = ?",
      [uid.trim()]
    );

    if (estagiarios.length === 0) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Cartão não cadastrado no sistema"
      });
    }

    const estagiario = estagiarios[0];
    const hoje = new Date().toISOString().split('T')[0];
    const agora = new Date().toTimeString().split(' ')[0];

    let resultado;
    let mensagem = "";

    if (tipo === "ENTRADA" || !tipo) {
      // Registrar ENTRADA
      resultado = await registrarEntrada(estagiario.id, hoje, agora);
      mensagem = "Entrada registrada com sucesso";
    } else if (tipo === "SAIDA") {
      // Registrar SAÍDA
      resultado = await registrarSaida(estagiario.id, hoje, agora);
      mensagem = "Saída registrada com sucesso";
    } else {
      // Registro automático (como o RFID)
      resultado = await registroAutomatico(estagiario.id, hoje, agora);
      mensagem = `Presença ${resultado.tipo} registrada com sucesso`;
    }

    console.log(`✅ ${mensagem} para: ${estagiario.nome}`);

    res.json({
      sucesso: true,
      mensagem: mensagem,
      tipo: resultado.tipo,
      horario: agora,
      data: hoje,
      estagiario: {
        id: estagiario.id,
        nome: estagiario.nome,
        numero_processo: estagiario.numero_processo,
        curso: estagiario.curso
      },
      registro: resultado.registro
    });

  } catch (err) {
    console.error("❌ Erro ao registrar presença:", err);
    res.status(500).json({
      sucesso: false,
      mensagem: "Erro interno do servidor ao registrar presença"
    });
  }
});

// Endpoint para registro rápido de presença (apenas UID)
app.post("/presencas/registro-rapido", async (req, res) => {
  try {
    const { uid } = req.body;
   
    if (!uid) {
      return res.status(400).json({
        sucesso: false,
        mensagem: "UID do cartão é obrigatório"
      });
    }

    console.log(`⚡ Registro rápido de presença para UID: ${uid}`);

    // Busca estagiário (corrigido para usar codigo_rfid)
    const [estagiarios] = await pool.query(
      "SELECT id, nome FROM estagiarios WHERE codigo_rfid = ?",
      [uid.trim()]
    );

    if (estagiarios.length === 0) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Cartão não cadastrado"
      });
    }

    const estagiario = estagiarios[0];
    const hoje = new Date().toISOString().split('T')[0];
    const agora = new Date().toTimeString().split(' ')[0];

    const resultado = await registroAutomatico(estagiario.id, hoje, agora);

    res.json({
      sucesso: true,
      mensagem: `Presença ${resultado.tipo} registrada`,
      tipo: resultado.tipo,
      horario: agora,
      estagiario: {
        id: estagiario.id,
        nome: estagiario.nome
      }
    });

  } catch (err) {
    console.error("❌ Erro no registro rápido:", err);
    res.status(500).json({
      sucesso: false,
      mensagem: "Erro ao registrar presença"
    });
  }
});

// Endpoint para obter presenças do dia atual
app.get("/presencas/hoje", async (req, res) => {
  try {
    const hoje = new Date().toISOString().split('T')[0];
   
    // Busca todos os estagiários
    const [todosEstagiarios] = await pool.query("SELECT id, nome, numero_processo, curso, codigo_rfid FROM estagiarios");
   
    // Busca presenças do dia
    const [presencas] = await pool.query(
      `SELECT p.*, e.nome, e.numero_processo, e.curso, e.codigo_rfid
       FROM presencas p
       JOIN estagiarios e ON p.estagiario_id = e.id
       WHERE p.data = ?
       ORDER BY p.hora_entrada DESC`,
      [hoje]
    );

    // Identificar estagiários que faltaram
    const estagiariosComPresenca = presencas.map(p => p.estagiario_id);
    const estagiariosQueFaltaram = todosEstagiarios.filter(est => !estagiariosComPresenca.includes(est.id));

    // Formatar resposta
    const resposta = {
      sucesso: true,
      data: hoje,
      total_estagiarios: todosEstagiarios.length,
      total_presentes: presencas.length,
      total_faltas: estagiariosQueFaltaram.length,
      presencas: presencas,
      faltas: estagiariosQueFaltaram.map(est => ({
        id: est.id,
        nome: est.nome,
        numero_processo: est.numero_processo,
        curso: est.curso,
        codigo_rfid: est.codigo_rfid
      }))
    };

    res.json(resposta);

  } catch (err) {
    console.error("❌ Erro ao buscar presenças de hoje:", err);
    res.status(500).json({
      sucesso: false,
      mensagem: "Erro ao buscar presenças do dia"
    });
  }
});

// Endpoint para obter histórico de presenças por estagiário
app.get("/presencas/estagiario/:codigoRfid", async (req, res) => {
  try {
    const { codigoRfid } = req.params;
    const { limite = 30 } = req.query;

    // Busca estagiário pelo código RFID (corrigido para usar codigo_rfid)
    const [estagiarios] = await pool.query(
      "SELECT id, nome FROM estagiarios WHERE codigo_rfid = ?",
      [codigoRfid]
    );

    if (estagiarios.length === 0) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Estagiário não encontrado"
      });
    }

    const estagiario = estagiarios[0];

    const [presencas] = await pool.query(
      `SELECT * FROM presencas
       WHERE estagiario_id = ?
       ORDER BY data DESC, hora_entrada DESC
       LIMIT ?`,
      [estagiario.id, parseInt(limite)]
    );

    res.json({
      sucesso: true,
      estagiario: {
        id: estagiario.id,
        nome: estagiario.nome
      },
      total_registros: presencas.length,
      presencas: presencas
    });

  } catch (err) {
    console.error("❌ Erro ao buscar histórico:", err);
    res.status(500).json({
      sucesso: false,
      mensagem: "Erro ao buscar histórico de presenças"
    });
  }
});

// Endpoint para registrar faltas no final do dia
app.post("/presencas/registrar-faltas", async (req, res) => {
  try {
    const hoje = new Date().toISOString().split('T')[0];
   
    // Busca todos os estagiários
    const [todosEstagiarios] = await pool.query("SELECT id FROM estagiarios");
   
    // Busca presenças do dia
    const [presencas] = await pool.query(
      "SELECT estagiario_id FROM presencas WHERE data = ?",
      [hoje]
    );

    // Identificar estagiários que faltaram
    const estagiariosComPresenca = presencas.map(p => p.estagiario_id);
    const estagiariosQueFaltaram = todosEstagiarios.filter(est => !estagiariosComPresenca.includes(est.id));

    // Registrar falta para cada estagiário que faltou
    let faltasRegistradas = 0;
    for (const estagiario of estagiariosQueFaltaram) {
      await pool.query(
        "INSERT INTO presencas (estagiario_id, data) VALUES (?, ?)",
        [estagiario.id, hoje]
      );
      faltasRegistradas++;
    }

    console.log(`✅ ${faltasRegistradas} faltas registradas para ${hoje}`);

    res.json({
      sucesso: true,
      mensagem: `${faltasRegistradas} faltas registradas com sucesso`,
      data: hoje,
      total_faltas: faltasRegistradas
    });

  } catch (err) {
    console.error("❌ Erro ao registrar faltas:", err);
    res.status(500).json({
      sucesso: false,
      mensagem: "Erro ao registrar faltas"
    });
  }
});

// ==================== FUNÇÕES AUXILIARES ====================

/**
 * Registra entrada do estagiário
 */
async function registrarEntrada(estagiarioId, data, horario) {
  // Verifica se já existe uma entrada sem saída no mesmo dia
  const [presencasAbertas] = await pool.query(
    "SELECT id FROM presencas WHERE estagiario_id = ? AND data = ? AND hora_saida IS NULL",
    [estagiarioId, data]
  );

  if (presencasAbertas.length > 0) {
    throw new Error("Já existe uma entrada registrada sem saída para hoje");
  }

  // Registra nova entrada
  const [result] = await pool.query(
    "INSERT INTO presencas (estagiario_id, data, hora_entrada) VALUES (?, ?, ?)",
    [estagiarioId, data, horario]
  );

  return {
    tipo: "ENTRADA",
    registro: { id: result.insertId, hora_entrada: horario }
  };
}

/**
 * Registra saída do estagiário
 */
async function registrarSaida(estagiarioId, data, horario) {
  // Busca a última entrada sem saída
  const [presencasAbertas] = await pool.query(
    "SELECT id, hora_entrada FROM presencas WHERE estagiario_id = ? AND data = ? AND hora_saida IS NULL ORDER BY hora_entrada DESC LIMIT 1",
    [estagiarioId, data]
  );

  if (presencasAbertas.length === 0) {
    throw new Error("Não há entrada registrada para registrar saída");
  }

  const presenca = presencasAbertas[0];

  // Atualiza com a saída
  await pool.query(
    "UPDATE presencas SET hora_saida = ? WHERE id = ?",
    [horario, presenca.id]
  );

  return {
    tipo: "SAIDA",
    registro: {
      id: presenca.id,
      hora_entrada: presenca.hora_entrada,
      hora_saida: horario
    }
  };
}

/**
 * Registro automático (entrada/saída alternada)
 */
async function registroAutomatico(estagiarioId, data, horario) {
  // Busca o último registro do dia
  const [ultimasPresencas] = await pool.query(
    "SELECT id, hora_entrada, hora_saida FROM presencas WHERE estagiario_id = ? AND data = ? ORDER BY hora_entrada DESC LIMIT 1",
    [estagiarioId, data]
  );

  if (ultimasPresencas.length === 0) {
    // Primeira entrada do dia
    const resultado = await registrarEntrada(estagiarioId, data, horario);
    return resultado;
  }

  const ultimaPresenca = ultimasPresencas[0];

  if (!ultimaPresenca.hora_saida) {
    // Tem entrada mas não tem saída - registrar saída
    const resultado = await registrarSaida(estagiarioId, data, horario);
    return resultado;
  } else {
    // Já registrou entrada e saída - nova entrada
    const resultado = await registrarEntrada(estagiarioId, data, horario);
    return resultado;
  }
}

// Endpoint para obter UID disponível (para cadastro)
app.get("/rfid/uid-disponivel", async (req, res) => {
  try {
    const [estagiarios] = await pool.query(
      "SELECT codigo_rfid FROM estagiarios WHERE codigo_rfid IS NOT NULL AND codigo_rfid != ''"
    );
   
    const uidsCadastrados = estagiarios.map(e => e.codigo_rfid);
   
    res.json({
      sucesso: true,
      uids_cadastrados: uidsCadastrados,
      total_cadastrados: uidsCadastrados.length
    });
   
  } catch (err) {
    console.error("Erro ao buscar UIDs:", err);
    res.status(500).json({
      sucesso: false,
      mensagem: "Erro ao buscar UIDs cadastrados"
    });
  }
});

// Endpoint para verificar se UID já está em uso
app.post("/rfid/verificar-uid", async (req, res) => {
  try {
    const { uid } = req.body;
   
    if (!uid) {
      return res.json({
        sucesso: false,
        mensagem: "UID não fornecido"
      });
    }

    const [estagiarios] = await pool.query(
      "SELECT id, nome FROM estagiarios WHERE codigo_rfid = ?",
      [uid]
    );

    if (estagiarios.length > 0) {
      return res.json({
        sucesso: true,
        disponivel: false,
        mensagem: "UID já está em uso",
        estagiario: estagiarios[0]
      });
    }

    res.json({
      sucesso: true,
      disponivel: true,
      mensagem: "UID disponível para cadastro"
    });

  } catch (err) {
    console.error("Erro ao verificar UID:", err);
    res.status(500).json({
      sucesso: false,
      mensagem: "Erro ao verificar UID"
    });
  }
});
// ==================== FIM ENDPOINTS RFID ====================

// --------------------
// Authentication (basic)
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
    // Accept photo sent as 'fotoPerfil' from frontend and map to 'foto' DB column
    if (body.fotoPerfil) {
      body.foto = body.fotoPerfil;
      delete body.fotoPerfil;
    }
    // minimal required fields validation
    const required = ["nome", "data_nascimento", "genero", "numero_processo", "curso", "password"];
    for (const f of required) if (!body[f]) return res.status(400).json({ error: `${f} é obrigatório` });

    // If a plain password was provided, hash it here and store under password_hash
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
    // Accept photo sent as 'fotoPerfil' from frontend
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
app.get("/mt", async (req, res) => {
  try { const [rows] = await pool.query("SELECT * FROM visitas ORDER BY id DESC"); res.json(rows); }
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
// Admin migration endpoint: alter foto columns to LONGTEXT on demand
// WARNING: Enabled only if ALLOW_MIGRATE=true in env (safety)
app.post('/admin/migrate/foto-columns', async (req, res) => {
  try {
    if (process.env.ALLOW_MIGRATE !== 'true') return res.status(403).json({ error: 'Migration not allowed' });
    // multipleStatements is enabled on pool, run both alters
    await pool.query('ALTER TABLE professores MODIFY foto LONGTEXT; ALTER TABLE estagiarios MODIFY foto LONGTEXT;');
    return res.json({ ok: true, message: 'Migration executed' });
  } catch (err) {
    console.error('Migration error', err);
    return res.status(500).json({ error: 'Migration failed', details: err.message });
  }
});
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
app.listen(PORT, () => console.log(`Smart Lab API rodando na porta ${PORT}`));
