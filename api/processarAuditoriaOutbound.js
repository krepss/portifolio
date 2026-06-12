export default async function handler(req, res) {
  // Aceita apenas método POST
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const { token, baseUrl, idFila, intervaloStr } = req.body;
  if (!token || !idFila || !intervaloStr) {
    return res.status(400).json({ error: true, message: 'Parâmetros ausentes.' });
  }

  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');

  // Helper para requisições
  async function callGenesys(path, method = 'get', payload = null) {
    const opts = { 
      method: method.toUpperCase(), 
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } 
    };
    if (payload) opts.body = JSON.stringify(payload);
    
    const response = await fetch(`${cleanUrl}${path}`, opts);
    if (!response.ok) return { erro: `HTTP ${response.status}` };
    return await response.json();
  }

  // Helper para extrair o DDD do número
  function extrairDDD(numero) {
    let soNumeros = String(numero).replace(/\D/g, '');
    if (soNumeros.startsWith('55') && soNumeros.length >= 12) return soNumeros.substring(2, 4);
    if (soNumeros.startsWith('0') && soNumeros.length >= 11) return soNumeros.substring(1, 3);
    if (soNumeros.length >= 10) return soNumeros.substring(0, 2);
    return "N/A";
  }

  // Caches locais para não sobrecarregar a API traduzindo o mesmo ID várias vezes
  const cacheUsuarios = {};
  async function obterNomeOperador(userId) {
    if (!userId) return "Sistema";
    if (cacheUsuarios[userId]) return cacheUsuarios[userId];
    const r = await callGenesys(`/api/v2/users/${userId}`);
    const n = r && !r.erro && r.name ? r.name : `Desconhecido (${userId})`;
    cacheUsuarios[userId] = n;
    return n;
  }

  const cacheWrapup = {};
  async function obterNomeFinalizacao(wrapupId) {
    if (!wrapupId) return "Sem Finalização";
    if (cacheWrapup[wrapupId]) return cacheWrapup[wrapupId];
    if (String(wrapupId).startsWith("ININ-")) { 
      const ns = wrapupId.replace("ININ-WRAP-UP-", "").replace("ININ-OUTBOUND-", ""); 
      cacheWrapup[wrapupId] = ns; 
      return ns;
    }
    const r = await callGenesys(`/api/v2/routing/wrapupcodes/${wrapupId}`);
    const n = r && !r.erro && r.name ? r.name : `Código (${wrapupId})`;
    cacheWrapup[wrapupId] = n;
    return n;
  }

  try {
    let paginaAtual = 1;
    let temMaisDados = true;
    let agrupamento = {};

    // 1. Extraindo as chamadas ativas da fila de forma paginada
    while (temMaisDados) {
      const payload = {
        "interval": intervaloStr,
        "segmentFilters": [{ 
          "type": "and", 
          "predicates": [ 
            {"dimension": "mediaType", "value": "voice"}, 
            {"dimension": "direction", "value": "outbound"}, 
            {"dimension": "queueId", "value": idFila} 
          ] 
        }],
        "paging": {"pageSize": 100, "pageNumber": paginaAtual}
      };
      
      const response = await callGenesys("/api/v2/analytics/conversations/details/query", "post", payload);
      if (response.erro) return res.status(200).json({ error: true, message: "Erro na extração: " + response.erro });

      const conversas = response.conversations || [];
      if (conversas.length === 0) { 
        temMaisDados = false;
      } else {
        for (let i = 0; i < conversas.length; i++) {
          const conv = conversas[i];
          let dataFormatada = "Desconhecida";
          let dataHoraOriginal = "Desconhecida";
          let duracaoTotal = 0;

          if (conv.conversationStart) { 
            const ds = new Date(conv.conversationStart);
            // Formatação no fuso de São Paulo / Brasília
            dataHoraOriginal = ds.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
            const dataSplit = conv.conversationStart.split('T')[0].split('-'); 
            dataFormatada = `${dataSplit[2]}/${dataSplit[1]}/${dataSplit[0]}`;
            if (conv.conversationEnd) {
              duracaoTotal = new Date(conv.conversationEnd).getTime() - ds.getTime();
            }
          }
          
          let durSeg = Math.round(duracaoTotal / 1000);
          let durFormatada = String(Math.floor(durSeg/60)).padStart(2,'0') + "m " + String(durSeg%60).padStart(2,'0') + "s";

          let numeroLimpo = null; 
          let agenteId = null;
          let wrapupId = null; 
          let participants = conv.participants || [];

          for (let p = 0; p < participants.length; p++) {
            let part = participants[p];
            if (part.purpose === "customer" || part.purpose === "external") { 
              let sessions = part.sessions || [];
              for (let s = 0; s < sessions.length; s++) { 
                let num = sessions[s].dnis || sessions[s].ani || "";
                if (num) numeroLimpo = num.replace("tel:", "").replace("+", "").trim(); 
              } 
            }
            if (part.purpose === "agent" || part.purpose === "user") { 
              if (part.userId) agenteId = part.userId;
              let sessionsAgent = part.sessions || []; 
              for (let sa = 0; sa < sessionsAgent.length; sa++) { 
                let segments = sessionsAgent[sa].segments || []; 
                for (let sg = 0; sg < segments.length; sg++) { 
                  if (segments[sg].wrapUpCode) wrapupId = segments[sg].wrapUpCode;
                } 
              } 
            }
          }
          
          if (numeroLimpo && agenteId) { 
            let ddd = extrairDDD(numeroLimpo);
            let chave = `${dataFormatada}|${ddd}|${numeroLimpo}|${agenteId}|${wrapupId}`;
            if (!agrupamento[chave]) agrupamento[chave] = { tentativas: 0, detalhes: [] }; 
            agrupamento[chave].tentativas++; 
            agrupamento[chave].detalhes.push({ dataHora: dataHoraOriginal, duracao: durFormatada });
          }
        }
        paginaAtual++;
      }
    }
    
    // 2. Filtrando e construindo o relatório
    let linhasRelatorio = []; 
    let chaves = Object.keys(agrupamento);
    if (chaves.length === 0) return res.status(200).json({ error: false, data: [] });

    for (let k = 0; k < chaves.length; k++) { 
      let partes = chaves[k].split("|");
      // Apenas mostra números chamados mais de 1 vez
      if (agrupamento[chaves[k]].tentativas > 1) { 
        let nomeAgente = await obterNomeOperador(partes[3]);
        let nomeWrapup = await obterNomeFinalizacao(partes[4]);

        linhasRelatorio.push({ 
          data: partes[0], 
          ddd: partes[1], 
          numero: partes[2], 
          agente: nomeAgente, 
          wrapup: nomeWrapup, 
          tentativas: agrupamento[chaves[k]].tentativas,
          detalhes: agrupamento[chaves[k]].detalhes 
        });
      } 
    }
    
    linhasRelatorio.sort((a, b) => b.tentativas - a.tentativas);
    return res.status(200).json({ error: false, data: linhasRelatorio });

  } catch (erro) { 
    return res.status(500).json({ error: true, message: String(erro) });
  }
}
