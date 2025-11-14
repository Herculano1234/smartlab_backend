-- INÍCIO DO SCRIPT SQL PARA INICIALIZAÇÃO DO BANCO DE DADOS
-- ===========================
-- TABELA: Professores
-- ===========================
CREATE TABLE IF NOT EXISTS professores (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(100) NOT NULL,
  genero ENUM('Masculino', 'Feminino') NOT NULL,
  disciplina VARCHAR(100),
  telefone VARCHAR(20),
  email VARCHAR(100) UNIQUE,
  foto TEXT,
  cargo_instituicao VARCHAR(100),
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================
-- TABELA: Tipos de Materiais
-- ===========================
CREATE TABLE IF NOT EXISTS tipos_materiais (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome_tipo VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================
-- TABELA: Visitas
-- ===========================
CREATE TABLE IF NOT EXISTS visitas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(100) NOT NULL,
  genero ENUM('Masculino', 'Feminino') NOT NULL,
  numero_processo VARCHAR(50),
  telefone VARCHAR(20),
  email VARCHAR(100),
  morada TEXT,
  curso VARCHAR(100),
  turma VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================
-- TABELA: Estagiários
-- ===========================
CREATE TABLE IF NOT EXISTS estagiarios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(100) NOT NULL,
  data_nascimento DATE NOT NULL,
  genero ENUM('Masculino', 'Feminino') NOT NULL,
  morada TEXT,
  telefone VARCHAR(20),
  email VARCHAR(100) UNIQUE,
  foto TEXT,
  escola_origem VARCHAR(100),
  numero_processo VARCHAR(50) UNIQUE,
  curso VARCHAR(100),
  turma VARCHAR(50),
  area_de_estagio VARCHAR(100),
  codigo_rfid VARCHAR(50) UNIQUE,
  estado_estagio ENUM('Pendente', 'Decorrendo', 'Terminado') DEFAULT 'Pendente',
  data_inicio_estado DATE,
  id_professor INT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_estagiarios_professor FOREIGN KEY (id_professor)
    REFERENCES professores(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================
-- TABELA: Materiais
-- ===========================
CREATE TABLE IF NOT EXISTS materiais (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome_material VARCHAR(100) NOT NULL,
  code_id VARCHAR(50) UNIQUE NOT NULL,
  id_tipo_material INT NULL,
  descricao TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_materiais_tipo FOREIGN KEY (id_tipo_material)
    REFERENCES tipos_materiais(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================
-- TABELA: Empréstimos
-- ===========================
CREATE TABLE IF NOT EXISTS emprestimos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  id_material INT,
  id_estagiario INT,
  id_visita INT,
  data_inicio DATE NOT NULL,
  data_final DATE,
  status ENUM('Em uso', 'Devolvido', 'Vencido') DEFAULT 'Em uso',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_emprestimos_material FOREIGN KEY (id_material)
    REFERENCES materiais(id) ON DELETE CASCADE,
  CONSTRAINT fk_emprestimos_estagiario FOREIGN KEY (id_estagiario)
    REFERENCES estagiarios(id) ON DELETE CASCADE,
  CONSTRAINT fk_emprestimos_visita FOREIGN KEY (id_visita)
    REFERENCES visitas(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================
-- TABELA: Presenças
-- ===========================
CREATE TABLE IF NOT EXISTS presencas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  estagiario_id INT NOT NULL,
  data DATE NOT NULL,
  hora_entrada TIME,
  hora_saida TIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_presencas_estagiario FOREIGN KEY (estagiario_id)
    REFERENCES estagiarios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================
-- TABELA: Histórico de Estado do Estágio
-- ===========================
CREATE TABLE IF NOT EXISTS historico_estagio (
  id INT AUTO_INCREMENT PRIMARY KEY,
  estagiario_id INT NOT NULL,
  estado ENUM('Pendente', 'Decorrendo', 'Terminado') NOT NULL,
  data_inicio DATE NOT NULL,
  data_fim DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_hist_estagio_estagiario FOREIGN KEY (estagiario_id)
    REFERENCES estagiarios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================
-- TABELA: Logs de Auditoria
-- ===========================
CREATE TABLE IF NOT EXISTS logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  usuario VARCHAR(100),
  acao TEXT,
  data_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- FIM DO SCRIPT SQL PARA INICIALIZAÇÃO DO BANCO DE DADOS