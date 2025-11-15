#!/usr/bin/env node
/**
 * Script simples para registrar um professor via endpoint `/auth/register`
 * Uso:
 *   node create_professor.js --url http://localhost:4000 --username "João Silva" --email joao@itel.com --password secret --genero Masculino
 *
 * Ou defina env var BACKEND_URL e chame:
 *   node create_professor.js --username "João Silva" --email joao@itel.com --password secret --genero Masculino
 */

import axios from 'axios';

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i+1] && !argv[i+1].startsWith('--') ? argv[++i] : true;
      args[key] = val;
    }
  }
  return args;
}

async function main() {
  const argv = parseArgs();
  const baseURL = argv.url || process.env.BACKEND_URL || 'http://localhost:4000';
  const username = argv.username || argv.u;
  const email = argv.email || argv.e;
  const password = argv.password || argv.p;
  const genero = argv.genero || argv.g;
  const foto = argv.foto || null; // optional data URL or URL

  if (!username || !email || !password || !genero) {
    console.error('Parâmetros obrigatórios: --username --email --password --genero');
    process.exit(2);
  }

  try {
    const resp = await axios.post(`${baseURL.replace(/\/$/, '')}/auth/register`, {
      username,
      email,
      password,
      role: 'professor',
      genero,
      foto
    }, { timeout: 15000 });

    console.log('Professor criado:', resp.data);
  } catch (err) {
    if (err.response) {
      console.error('Erro do servidor:', err.response.status, err.response.data);
    } else {
      console.error('Erro:', err.message);
    }
    process.exit(1);
  }
}

main();
