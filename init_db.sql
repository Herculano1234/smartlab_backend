-- Criação de tipos ENUM
CREATE TYPE genero_enum AS ENUM ('Masculino', 'Feminino');
CREATE TYPE estado_estagio_enum AS ENUM ('Pendente', 'Decorrendo', 'Terminado');
CREATE TYPE status_emprestimo_enum AS ENUM ('Em uso', 'Devolvido', 'Vencido');

-- Tabela: Professores
CREATE TABLE professores (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(100) NOT NULL,
  genero genero_enum NOT NULL,
  disciplina VARCHAR(100),
  telefone VARCHAR(20),
  email VARCHAR(100) UNIQUE,
  cargo_instituicao VARCHAR(100)
);

-- Tabela: Estagiários
CREATE TABLE estagiarios (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(100) NOT NULL,
  data_nascimento DATE NOT NULL,
  genero genero_enum NOT NULL,
  morada TEXT,
  telefone VARCHAR(20),
  email VARCHAR(100) UNIQUE,
  escola_origem VARCHAR(100),
  numero_processo VARCHAR(50) UNIQUE,
  curso VARCHAR(100),
  turma VARCHAR(50),
  area_de_estagio VARCHAR(100),
  codigo_rfid VARCHAR(50) UNIQUE,
  estado_estagio estado_estagio_enum DEFAULT 'Pendente',
  data_inicio_estado DATE,
  id_professor INTEGER REFERENCES professores(id) ON DELETE SET NULL
);

-- Tabela: Visitas
CREATE TABLE visitas (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(100) NOT NULL,
  genero genero_enum NOT NULL,
  numero_processo VARCHAR(50),
  telefone VARCHAR(20),
  email VARCHAR(100),
  morada TEXT,
  curso VARCHAR(100),
  turma VARCHAR(50)
);

-- Tabela: Tipos de Materiais
CREATE TABLE tipos_materiais (
  id SERIAL PRIMARY KEY,
  nome_tipo VARCHAR(100) NOT NULL
);

-- Tabela: Materiais
CREATE TABLE materiais (
  id SERIAL PRIMARY KEY,
  nome_material VARCHAR(100) NOT NULL,
  code_id VARCHAR(50) UNIQUE NOT NULL,
  id_tipo_material INTEGER REFERENCES tipos_materiais(id) ON DELETE SET NULL,
  descricao TEXT
);

-- Tabela: Empréstimos
CREATE TABLE emprestimos (
  id SERIAL PRIMARY KEY,
  id_material INTEGER REFERENCES materiais(id) ON DELETE CASCADE,
  id_estagiario INTEGER REFERENCES estagiarios(id) ON DELETE CASCADE,
  id_visita INTEGER REFERENCES visitas(id) ON DELETE CASCADE,
  data_inicio DATE NOT NULL,
  data_final DATE,
  status status_emprestimo_enum DEFAULT 'Em uso'
);

-- Tabela: Presenças
CREATE TABLE presencas (
  id SERIAL PRIMARY KEY,
  estagiario_id INTEGER REFERENCES estagiarios(id) ON DELETE CASCADE,
  data DATE NOT NULL,
  hora_entrada TIME,
  hora_saida TIME
);

-- Tabela: Histórico de Estado do Estágio
CREATE TABLE historico_estagio (
  id SERIAL PRIMARY KEY,
  estagiario_id INTEGER REFERENCES estagiarios(id) ON DELETE CASCADE,
  estado estado_estagio_enum NOT NULL,
  data_inicio DATE NOT NULL,
  data_fim DATE
);

-- Tabela: Logs de Auditoria
CREATE TABLE logs (
  id SERIAL PRIMARY KEY,
  usuario VARCHAR(100),
  acao TEXT,
  data_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);