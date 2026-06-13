export default async function handler(req, res) {
  // Configuração Global de Headers CORS para a Brisanet
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  // Captura a ação dinamicamente através do parâmetro action na URL ou no corpo
  const urlParts = req.url.split('?');
  const actionPath = urlParts[0].replace('/api/', '').replace('/api', '').trim();
  const action = actionPath || req.query.action || req.body.action;

  const { token, baseUrl } = req.body;
  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');

  // Cliente HTTP Universal Genesys Cloud
  async function callGenesys(path, method = 'get', payload = null) {
    const opts = {
      method: method.toUpperCase(),
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    };
    if (payload) opts.body = JSON.stringify(payload);
    const response = await fetch(`${cleanUrl}${path}`, opts);
    if (response.status === 401) throw new Error('Token inválido ou expirado.');
    const text = await response.text();
    if (!response.ok) return { erro: `HTTP ${response.status}`, detalhe: text.substring(0, 300) };
    return text ? JSON.parse(text) : {};
  }

  try {
    switch (action) {
      
      case 'verificarToken': {
        if (!token) return res.status(200).json({ valido: false, message: 'Token ausente.' });
        const data = await callGenesys('/api/v2/users/me');
        if (data.erro) return res.status(200).json({ valido: false, message: data.erro });
        return res.status(200).json({
          valido: true,
          nome: data.name || 'Usuário',
          email: data.email || '',
          divisao: data.division ? data.division.name : ''
        });
      }

      case 'listarFilas': {
        const filas = [];
        for (let p = 1; p <= 10; p++) {
          const data = await callGenesys(`/api/v2/routing/queues?pageSize=100&pageNumber=${p}&sortBy=name&sortOrder=asc`);
          if (data.erro || !data.entities || !data.entities.length) break;
          data.entities.forEach(q => filas.push({ id: q.id, nome: q.name, membros: q.memberCount || 0 }));
          if (data.pageCount && p >= data.pageCount) break;
        }
        return res.status(200).json({ filas });
      }

      case 'buscarEquipesDisponiveis': {
        const data = await callGenesys('/api/v2/teams?pageSize=100');
        if (data.erro || !data.entities) return res.status(200).json([]);
        return res.status(200).json(data.entities.map(t => ({ id: t.id, nome: t.name })));
      }

      case 'buscarMembrosGrupo': {
        const { teamId } = req.body;
        const data = await callGenesys(`/api/v2/teams/${teamId}/members?pageSize=100&expand=entities`);
        if (data.erro || !data.entities) return res.status(200).json([]);

        // Extrai IDs — a entidade pode vir como { id } raiz ou { user: { id } }
        let idsRaw = data.entities.map(m => {
          let userObj = m.user || m || {};
          return userObj.id || m.id || '';
        }).filter(id => id !== '');

        if (idsRaw.length === 0) return res.status(200).json([]);

        // Busca nomes em lote via /api/v2/users?id[]=...
        const idsQuery = idsRaw.map(id => `id=${encodeURIComponent(id)}`).join('&');
        const rUsers = await callGenesys(`/api/v2/users?pageSize=100&${idsQuery}`);
        const nomeMap = {};
        if (rUsers.entities) {
          rUsers.entities.forEach(u => { if (u.id) nomeMap[u.id] = u.name || u.id; });
        }

        const membros = idsRaw.map(id => ({ id, nome: nomeMap[id] || id }));
        membros.sort((a, b) => a.nome.localeCompare(b.nome));
        return res.status(200).json(membros);
      }

      case 'buscarWrapupsDaFila': {
        const { queueId } = req.body;
        const data = await callGenesys(`/api/v2/routing/queues/${queueId}/wrapupcodes?pageSize=100`);
        if (data.erro || !data.entities) return res.status(200).json([]);
        return res.status(200).json(data.entities.map(w => ({ id: w.id, nome: w.name })));
      }

      case 'carregarDadosDashboard': {
        const { queueId, groupId, intervaloIso, ehHoje } = req.body;
        let membrosGrupo = null;
        if (groupId) {
          const resGrupo = await callGenesys(`/api/v2/teams/${groupId}/members?pageSize=100`);
          if (resGrupo.entities) membrosGrupo = resGrupo.entities.map(m => (m.user && m.user.id) || m.id).filter(Boolean);
        }
        
        const dicPresencas = {};
        const resPres = await callGenesys('/api/v2/presencedefinitions?pageSize=100');
        if (resPres.entities) {
          resPres.entities.forEach(p => {
            let pName = p.name;
            if (p.languageLabels) {
              if (p.languageLabels["pt-BR"]) pName = p.languageLabels["pt-BR"];
              else if (p.languageLabels["pt_BR"]) pName = p.languageLabels["pt_BR"];
            }
            dicPresencas[p.id] = pName;
          });
        }
        
        // Mapeamento idêntico ao "traducoesPadrao" do teu cod.gs original
        const traducoesPadrao = {
          "Available": "Disponível", "AVAILABLE": "Disponível",
          "Break": "Pausa Básica", "BREAK": "Pausa Básica",
          "Meal": "Pausa Refeição", "MEAL": "Pausa Refeição",
          "Meeting": "Reunião", "MEETING": "Reunião",
          "Training": "Treinamento", "TRAINING": "Treinamento",
          "Away": "Ausente do PC", "AWAY": "Ausente do PC",
          "Busy": "Ocupado", "BUSY": "Ocupado"
        };

        let agentes = []; let paginaAtual = 1; let temMaisDados = true; let interagindoAgoraGlobal = 0;

        while (temMaisDados) {
          const rUsers = await callGenesys(`/api/v2/routing/queues/${queueId}/members?expand=presence&expand=routingStatus&expand=conversationSummary&pageSize=100&pageNumber=${paginaAtual}`);
          if (rUsers.erro || !rUsers.entities || !rUsers.entities.length) break;
          
          rUsers.entities.forEach(member => {
            let uObj = member.user || member || {}; 
            let userId = uObj.id || member.id;
            if (membrosGrupo && membrosGrupo.indexOf(userId) === -1) return;
            
            let rStatus = (member.routingStatus || uObj.routingStatus || {}).status || "UNKNOWN";
            let presenceDef = (member.presence || uObj.presence || {}).presenceDefinition || {};
            let sysPresenceRaw = presenceDef.systemPresence || "Offline";
            // Normaliza para comparação robusta independente de case/separador
            let sysPresenceUp = sysPresenceRaw.toUpperCase().replace(/[_\s]/g, '');
            let modifiedDate = (member.presence || uObj.presence || {}).modifiedDate || new Date().toISOString();
            
            let qtdInteracoes = 0;
            if (member.conversationSummary) {
              ['call', 'callback', 'chat', 'email', 'message', 'socialExpression', 'video'].forEach(c => {
                if (member.conversationSummary[c] && member.conversationSummary[c].contactCenter) qtdInteracoes += member.conversationSummary[c].contactCenter.active || 0;
              });
            }
            interagindoAgoraGlobal += qtdInteracoes;
            
            let statusAmigavel = "Offline"; let tipoClass = "offline";
            if (sysPresenceUp !== "OFFLINE") {
              if (sysPresenceUp === "ONQUEUE") {
                if (rStatus === "INTERACTING" || rStatus === "COMMUNICATING") { statusAmigavel = "Em Atendimento"; tipoClass = "busy"; }
                else if (rStatus === "NOT_RESPONDING") { statusAmigavel = "Não Respondendo"; tipoClass = "away"; }
                else { statusAmigavel = "Disponível"; tipoClass = "available"; }
              } else {
                let statusSecundario = dicPresencas[presenceDef.id] || presenceDef.name || "";
                if (statusSecundario) {
                  statusAmigavel = traducoesPadrao[statusSecundario] || traducoesPadrao[statusSecundario.toUpperCase()] || statusSecundario;
                } else {
                  statusAmigavel = traducoesPadrao[sysPresenceRaw] || traducoesPadrao[sysPresenceUp] || sysPresenceRaw;
                }
                if (sysPresenceUp === "AVAILABLE" || sysPresenceUp === "INTERACTING") {
                   if (sysPresenceUp === "INTERACTING") statusAmigavel = "Fora da Fila / Pessoal";
                   tipoClass = "acw";
                } else { tipoClass = "break"; }
              }
            }
            
            agentes.push({
              id: userId, nome: member.name || uObj.name || "Operador Desconhecido", status: statusAmigavel, sysClass: tipoClass,
              pausaMs: Date.now() - new Date(modifiedDate).getTime(), interagindo: qtdInteracoes, email: uObj.email || ''
            });
          });
          if (!rUsers.nextUri) temMaisDados = false; else paginaAtual++;
        }
        
        let esperandoAgora = 0;
        const rObs = await callGenesys('/api/v2/analytics/queues/observations/query', 'post', { "filter": { "type": "and", "predicates": [ { "type": "dimension", "dimension": "queueId", "value": queueId } ] }, "metrics": ["oWaiting"] });
        if (rObs.results && rObs.results[0]?.data) rObs.results[0].data.forEach(d => { if(d.metric === 'oWaiting') esperandoAgora = d.stats.count || 0; });

        const rAggFila = await callGenesys('/api/v2/analytics/conversations/aggregates/query', 'post', { "interval": intervaloIso, "groupBy": ["queueId", "mediaType"], "filter": { "type": "and", "predicates": [ { "type": "dimension", "dimension": "queueId", "value": queueId } ] }, "metrics": ["tAnswered", "tHandle", "tAcw", "oServiceLevel", "nOffered", "tAbandon", "tWait"] });
        let resultFila = { slaNumerator: 0, slaDenominator: 0, slaRatioFallback: null, sumTAnswered: 0, countTAnswered: 0, sumTHandle: 0, countTHandle: 0, sumTAcw: 0, countTAcw: 0, sumTWait: 0, countTWait: 0, nOfertadas: 0, nAbandonadas: 0 };
        if (rAggFila.results) {
          rAggFila.results.forEach(rg => rg.data?.forEach(d => d.metrics?.forEach(m => {
            if (m.metric === "tAnswered") { resultFila.sumTAnswered += m.stats.sum||0; resultFila.countTAnswered += m.stats.count||0; }
            if (m.metric === "tHandle") { resultFila.sumTHandle += m.stats.sum||0; resultFila.countTHandle += m.stats.count||0; }
            if (m.metric === "tAcw") { resultFila.sumTAcw += m.stats.sum||0; resultFila.countTAcw += m.stats.count||0; }
            if (m.metric === "tWait") { resultFila.sumTWait += m.stats.sum||0; resultFila.countTWait += m.stats.count||0; }
            if (m.metric === "nOffered") resultFila.nOfertadas += m.stats.count||0;
            if (m.metric === "tAbandon") resultFila.nAbandonadas += m.stats.count||0;
            if (m.metric === "oServiceLevel" && m.stats) { resultFila.slaNumerator += m.stats.numerator||0; resultFila.slaDenominator += m.stats.denominator||0; if (m.stats.ratio !== undefined) resultFila.slaRatioFallback = m.stats.ratio; }
          })));
        }
        
        const rAggAgentes = await callGenesys('/api/v2/analytics/conversations/aggregates/query', 'post', { "interval": intervaloIso, "groupBy": ["userId", "mediaType"], "filter": { "type": "and", "predicates": [ { "type": "dimension", "dimension": "queueId", "value": queueId } ] }, "metrics": ["tHandle", "tAcw", "tHeld", "nTransferred"] });
        let mapAgentes = {};
        if (rAggAgentes.results) {
          rAggAgentes.results.forEach(rg => {
            let uid = rg.group?.userId;
            if (uid && rg.data) {
              if (!mapAgentes[uid]) mapAgentes[uid] = { handCnt:0, handSum:0, acwSum:0, heldSum:0, trans:0 };
              rg.data.forEach(d => d.metrics?.forEach(m => {
                if (m.metric === "tHandle") { mapAgentes[uid].handCnt += m.stats.count||0; mapAgentes[uid].handSum += m.stats.sum||0; }
                if (m.metric === "tAcw") mapAgentes[uid].acwSum += m.stats.sum||0;
                if (m.metric === "tHeld") mapAgentes[uid].heldSum += m.stats.sum||0;
                if (m.metric === "nTransferred") mapAgentes[uid].trans += m.stats.count||0;
              }));
            }
          });
        }
        
        agentes.forEach(a => {
           let st = mapAgentes[a.id] || { handCnt:0, handSum:0, acwSum:0, heldSum:0, trans:0 };
           a.atendidas = st.handCnt; a.aht = st.handCnt > 0 ? Math.round(st.handSum / st.handCnt / 1000) : 0;
           a.acwMedio = st.handCnt > 0 ? Math.round(st.acwSum / st.handCnt / 1000) : 0; a.transferencias = st.trans;
        });
        
        let slaFinal = 100.0; if (resultFila.slaDenominator > 0) slaFinal = (resultFila.slaNumerator / resultFila.slaDenominator) * 100; else if (resultFila.slaRatioFallback !== null) slaFinal = resultFila.slaRatioFallback * 100;
        return res.status(200).json({
          ok: true, isRealTime: typeof ehHoje === 'string' ? ehHoje === 'true' : !!ehHoje,
          fila: { emEspera: esperandoAgora, ativasAgora: interagindoAgoraGlobal, nOfertadas: resultFila.nOfertadas, nAtendidas: resultFila.countTAnswered, nAbandonadas: resultFila.nAbandonadas, taxaAbandono: resultFila.nOfertadas > 0 ? ((resultFila.nAbandonadas / resultFila.nOfertadas) * 100).toFixed(1) : '0.0', sla: slaFinal.toFixed(1), vma: resultFila.countTAnswered > 0 ? Math.round(resultFila.sumTAnswered / resultFila.countTAnswered / 1000) : 0, tme: resultFila.countTWait > 0 ? Math.round(resultFila.sumTWait / resultFila.countTWait / 1000) : 0, tma: resultFila.countTHandle > 0 ? Math.round(resultFila.sumTHandle / resultFila.countTHandle / 1000) : 0, tpc: resultFila.countTHandle > 0 ? Math.round(resultFila.sumTAcw / resultFila.countTHandle / 1000) : 0 },
          agentes
        });
      }

      case 'atualizarFast': {
        const { queueId, groupId } = req.body;
        let membrosGrupo = null;
        if (groupId) {
          const rg = await callGenesys(`/api/v2/teams/${groupId}/members?pageSize=100`);
          if (rg.entities) membrosGrupo = rg.entities.map(m => (m.user && m.user.id) || m.id).filter(Boolean);
        }
        let agentes = [];
        const rUsers = await callGenesys(`/api/v2/routing/queues/${queueId}/members?expand=presence&expand=routingStatus&expand=conversationSummary&pageSize=100`);
        if (rUsers.entities) {
          rUsers.entities.forEach(member => {
            let uObj = member.user || member; let userId = uObj.id || member.id;
            if (membrosGrupo && membrosGrupo.indexOf(userId) === -1) return;
            let rStatus = (member.routingStatus || uObj.routingStatus || {}).status || "UNKNOWN";
            let sysPresenceRawF = ((member.presence || uObj.presence || {}).presenceDefinition || {}).systemPresence || "Offline";
            let sysPresenceUpF = sysPresenceRawF.toUpperCase().replace(/[_\s]/g, '');
            let modifiedDate = (member.presence || uObj.presence || {}).modifiedDate || new Date().toISOString();
            let qtd = 0;
            if (member.conversationSummary?.call?.contactCenter) qtd = member.conversationSummary.call.contactCenter.active || 0;
            let cls = 'offline';
            if (sysPresenceUpF !== 'OFFLINE') {
              if (sysPresenceUpF === 'ONQUEUE') {
                cls = ['INTERACTING','COMMUNICATING'].includes(rStatus) ? 'busy' : 'available';
              } else {
                cls = 'break';
              }
            }
            agentes.push({ id: userId, status: sysPresenceRawF, sysClass: cls, pausaMs: Date.now() - new Date(modifiedDate).getTime(), interagindo: qtd });
          });
        }
        return res.status(200).json({ agentesStatus: agentes, filaEspera: 0, ativasAgora: 0, timestamp: new Date().toLocaleTimeString('pt-BR') });
      }

      case 'buscarDadosAgenteGlobal': {
        const { userId, intervaloIso } = req.body;
        const rAgg = await callGenesys('/api/v2/analytics/conversations/aggregates/query', 'post', { "interval": intervaloIso, "groupBy": ["userId", "mediaType"], "filter": { "type": "and", "predicates": [ { "type": "dimension", "dimension": "userId", "value": userId } ] }, "metrics": ["tHandle", "tAcw", "tHeld", "nTransferred"] });
        let k = { atendidas: 0, atendidasVoice: 0, atendidasDigital: 0, aht: 0, acwMedio: 0, tmeMedio: 0, transferencias: 0 };
        if (rAgg.results?.[0]?.data) {
          rAgg.results[0].data.forEach(d => d.metrics?.forEach(m => {
            if (m.metric === "tHandle") { k.atendidas += m.stats.count||0; k.aht = m.stats.count > 0 ? Math.round(m.stats.sum/m.stats.count/1000) : 0; }
            if (m.metric === "tAcw" && k.atendidas > 0) k.acwMedio = Math.round(m.stats.sum/k.atendidas/1000);
            if (m.metric === "nTransferred") k.transferencias += m.stats.count||0;
          }));
        }
        return res.status(200).json({ ok: true, kpis: k });
      }

      case 'deslogarAgente': {
        const { userId } = req.body;
        const rPres = await callGenesys('/api/v2/presencedefinitions?pageSize=100');
        let offId = rPres.entities?.find(p => p.systemPresence?.toUpperCase() === 'OFFLINE')?.id;
        if (!offId) return res.status(200).json({ ok: false, erro: 'ID Offline não localizado.' });
        await callGenesys(`/api/v2/users/${userId}/presences/PURECLOUD`, 'patch', { presenceDefinition: { id: offId } });
        return res.status(200).json({ ok: true, novoStatus: 'Offline' });
      }

      case 'processarAuditoriaOutbound': {
        const { idFila, intervaloStr } = req.body;
        const cacheNomes = {};
        const cacheWrapups = {};

        try {
          const rW = await callGenesys(`/api/v2/routing/queues/${idFila}/wrapupcodes?pageSize=100`);
          if (rW && rW.entities) {
            rW.entities.forEach(w => { cacheWrapups[w.id] = w.name; });
          }
        } catch(e) {}

        try {
          const rUsersFila = await callGenesys(`/api/v2/routing/queues/${idFila}/members?pageSize=100`);
          if (rUsersFila && rUsersFila.entities) {
            rUsersFila.entities.forEach(m => {
              let uObj = m.user || m || {};
              if (uObj.id) cacheNomes[uObj.id] = uObj.name || m.name || "Operador";
            });
          }
        } catch (e) {}

        let paginaAtual = 1; let temMaisDados = true; let agrupamento = {};

        while (temMaisDados) {
          const payload = { 
            "interval": intervaloStr, 
            "segmentFilters": [{ "type": "and", "predicates": [ {"dimension": "mediaType", "value": "voice"}, {"dimension": "direction", "value": "outbound"}, {"dimension": "queueId", "value": idFila} ] }], 
            "paging": {"pageSize": 100, "pageNumber": paginaAtual} 
          };
          
          const response = await callGenesys("/api/v2/analytics/conversations/details/query", "post", payload);
          if (response.erro) return res.status(200).json({ error: true, message: "Erro na extração: " + response.erro });
          
          const conversas = response.conversations || [];
          if (conversas.length === 0) { 
            temMaisDados = false; 
          } else {
            for (let i = 0; i < conversas.length; i++) {
              let conv = conversas[i];
              let dataFormatada = "Desconhecida"; let dataHoraOriginal = "Desconhecida"; let duracaoTotal = 0;
              
              if (conv.conversationStart) { 
                let ds = new Date(conv.conversationStart);
                dataHoraOriginal = ds.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                let dataSplit = conv.conversationStart.split('T')[0].split('-'); 
                dataFormatada = `${dataSplit[2]}/${dataSplit[1]}/${dataSplit[0]}`;
                if(conv.conversationEnd) duracaoTotal = new Date(conv.conversationEnd).getTime() - ds.getTime();
              }
              
              let durSeg = Math.round(duracaoTotal / 1000);
              let durFormatada = String(Math.floor(durSeg/60)).padStart(2,'0') + "m " + String(durSeg%60).padStart(2,'0') + "s";

              let numeroLimpo = null; let agenteId = null; let wrapupId = null;
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
                let soNumeros = numeroLimpo.replace(/\D/g, '');
                let ddd = "N/A";
                if (soNumeros.startsWith('55') && soNumeros.length >= 12) ddd = soNumeros.substring(2, 4);
                else if (soNumeros.startsWith('0') && soNumeros.length >= 11) ddd = soNumeros.substring(1, 3);
                else if (soNumeros.length >= 10) ddd = soNumeros.substring(0, 2);

                let chave = `${dataFormatada}|${ddd}|${numeroLimpo}|${agenteId}|${wrapupId || 'Sem'}`;
                if (!agrupamento[chave]) agrupamento[chave] = { tentativas: 0, detalhes: [] }; 
                agrupamento[chave].tentativas++; 
                agrupamento[chave].detalhes.push({ dataHora: dataHoraOriginal, duracao: durFormatada });
              }
            }
            paginaAtual++;
          }
        }
        
        let linhasRelatorio = []; let chaves = Object.keys(agrupamento);
        for (let k = 0; k < chaves.length; k++) { 
          let partes = chaves[k].split("|");
          if (agrupamento[chaves[k]].tentativas > 1) {
            let aId = partes[3];
            let wId = partes[4];
            let nomeOperadorFinal = cacheNomes[aId] || "Agente (" + aId.substring(0,5) + ")";
            let nomeFinalizacaoFinal = cacheWrapups[wId] || (wId.startsWith("ININ-") ? wId.replace("ININ-WRAP-UP-", "").replace("ININ-OUTBOUND-", "") : "Sem Finalização");

            linhasRelatorio.push({ 
              data: partes[0], ddd: partes[1], numero: partes[2], 
              agente: nomeOperadorFinal, wrapup: nomeFinalizacaoFinal, 
              tentativas: agrupamento[chaves[k]].tentativas, detalhes: agrupamento[chaves[k]].detalhes 
            });
          } 
        }
        linhasRelatorio.sort((a, b) => b.tentativas - a.tentativas);
        return res.status(200).json({ error: false, data: linhasRelatorio });
      }

     case 'processarAuditoriaIA': {
        const { conversationId, provider, model, apiKey, customPrompt } = req.body;
        
        // 1. Busca metadados da conversa no Genesys
        const cData = await callGenesys(`/api/v2/conversations/${conversationId}`);
        if (cData.erro) return res.status(200).json({ ok: false, erro: 'Erro ao buscar conversa no Genesys: ' + cData.erro });

        // Função interna para extração segura do nome do cliente (Mapeada do seu Code.gs)
        let cliente = "Desconhecido";
        let customerPart = cData.participants?.find(p => p.purpose === 'customer' || p.purpose === 'external');
        if (customerPart) {
          cliente = customerPart.name || "Não Identificado";
          if (customerPart.attributes) {
            Object.keys(customerPart.attributes).forEach(key => {
              let lKey = key.toLowerCase();
              if (lKey.includes('nome') || lKey.includes('name') || lKey === 'contatonome') {
                let val = String(customerPart.attributes[key]).trim();
                if (val && val.length > 2 && !/^[\d\+\s]+$/.test(val)) {
                  cliente = val;
                }
              }
            });
          }
          cliente = String(cliente).split('|')[0].split('/')[0].split('-')[0].trim();
          if (/^[\d\+\s\:]+$/.test(cliente) || cliente.toLowerCase() === 'guest' || cliente.toLowerCase() === 'cliente') {
            cliente = "Não Identificado";
          }
        }
// Puxa operadores, constrói a lista de tabulações e mapeia comunicações digitais
        let nomesAgentes = [];
        let tabulacoesLista = [];
        let communicationIds = [];

        (cData.participants || []).forEach(p => {
          // Captura IDs de chat/mensagem de QUALQUER participante da conversa
          ['messages', 'chats'].forEach(media => {
            if (p[media] && Array.isArray(p[media])) {
              p[media].forEach(s => {
                if (s.id && !communicationIds.includes(s.id)) {
                  communicationIds.push(s.id);
                }
              });
            }
          });

          if (p.purpose === 'agent' || p.purpose === 'user') {
            let agName = p.name || "Operador Desconhecido";
            if (!nomesAgentes.includes(agName)) nomesAgentes.push(agName);
            
            // CORREÇÃO: Varredura profunda idêntica ao seu Code.gs para capturar o Wrapup
            let wName = "Sem Tabulação";
            if (p.wrapup && p.wrapup.name) {
              wName = p.wrapup.name;
            } else if (p.wrapup && p.wrapup.code) {
              wName = p.wrapup.code.startsWith("ININ-") 
                ? p.wrapup.code.replace("ININ-WRAP-UP-", "").replace("ININ-OUTBOUND-", "") 
                : p.wrapup.code;
            } else {
              // Fallback profundo varrendo todas as mídias possíveis do participante
              let foundWrapup = false;
              ['sessions', 'calls', 'chats', 'messages', 'emails'].forEach(media => {
                if (p[media] && Array.isArray(p[media]) && !foundWrapup) {
                  p[media].forEach(s => {
                    (s.segments || []).forEach(sg => {
                      if (sg.wrapUpCode && !foundWrapup) {
                        wName = sg.wrapUpCode.startsWith("ININ-") 
                          ? sg.wrapUpCode.replace("ININ-WRAP-UP-", "").replace("ININ-OUTBOUND-", "") 
                          : sg.wrapUpCode;
                        foundWrapup = true;
                      }
                    });
                  });
                }
              });
            }
            tabulacoesLista.push(`<b>${agName}:</b> ${wName}`);
          }
        });

        let agente = nomesAgentes.join(", ") || "Nenhum Humano";
        let wrapup = tabulacoesLista.join(" <br> ") || "Nenhuma Tabulação Registrada";

        // 2. Extração Real das Mensagens Digitais pelo Servidor de Transcrições (Com Plano B para evitar Lag de Cache)
        var frasesBrutas = [];
        for (let mediaId of communicationIds) {
          try {
            const tUrl = `/api/v2/speechandtextanalytics/conversations/${conversationId}/communications/${mediaId}/transcripturls`;
            const resT = await callGenesys(tUrl, 'get');
            if (resT && resT.urls && Array.isArray(resT.urls)) {
              for (let u of resT.urls) {
                const resS3 = await fetch(u.url);
                if (resS3.ok) {
                  const transcritosObj = await resS3.json();
                  if (transcritosObj.transcripts && Array.isArray(transcritosObj.transcripts)) {
                    transcritosObj.transcripts.forEach(t => {
                      if (t.phrases && Array.isArray(t.phrases)) {
                        t.phrases.forEach(phrase => frasesBrutas.push(phrase));
                      }
                    });
                  }
                }
              }
            }
          } catch (e) {
            console.error("Falha ao ler bloco analítico:", e.message);
          }
        }

        // 🚨 PLANO B: Se o Genesys ainda não gerou a URL no S3, busca direto no chat ativo da conversa
        if (frasesBrutas.length === 0) {
          try {
            const rMessages = await callGenesys(`/api/v2/conversations/messages/${conversationId}/messages`);
            if (rMessages && rMessages.entities && rMessages.entities.length > 0) {
              rMessages.entities.forEach(m => {
                let purpose = m.direction === 'inbound' ? 'customer' : 'agent';
                frasesBrutas.push({
                  participantPurpose: purpose,
                  text: m.textBody || '[Mídia/Imagem]',
                  startTimeMs: new Date(m.time).getTime()
                });
              });
            } else {
              const rChats = await callGenesys(`/api/v2/conversations/chats/${conversationId}/messages`);
              if (rChats && rChats.entities && rChats.entities.length > 0) {
                rChats.entities.forEach(m => {
                  let purpose = (m.sender?.type === 'agent' || m.sender?.type === 'bot') ? 'agent' : 'customer';
                  frasesBrutas.push({
                    participantPurpose: purpose,
                    text: m.body || '[Ação]',
                    startTimeMs: new Date(m.timestamp).getTime()
                  });
                });
              }
            }
          } catch (e) {
            console.error("Falha no fallback de mensagens diretas:", e.message);
          }
        }

        // Se mesmo com o Plano B não achar nada, aí sim barra a requisição
        if (frasesBrutas.length === 0) {
          return res.status(200).json({ ok: false, erro: 'Nenhuma transcrição digital ou histórico de mensagens localizado para esta conversa.' });
        }

        // Ordena a cronologia das mensagens digitais
        frasesBrutas.sort((a, b) => {
          var timeA = a.startTimeMs ? Number(a.startTimeMs) : (a.startTime ? new Date(a.startTime).getTime() : 0);
          var timeB = b.startTimeMs ? Number(b.startTimeMs) : (b.startTime ? new Date(b.startTime).getTime() : 0);
          return timeA - timeB;
        });

        var transcricao = "";
        frasesBrutas.forEach(phrase => {
          var purpose = String(phrase.participantPurpose || "").toLowerCase();
          var speaker = "CLIENTE";
          if (purpose === "agent" || purpose === "user") {
              speaker = "OPERADOR HUMANO"; 
          } else if (['botflow', 'workflow', 'acd', 'ivr', 'system'].includes(purpose)) {
              speaker = "SISTEMA/URA";
          }
          transcricao += `${speaker}: ${phrase.text}\n`;
        });

        // 3. Montagem do Prompt de Orientação Estruturado (Igual ao seu Code.gs original)
        let instrucoesDinamicas = customPrompt && customPrompt.trim() !== "" 
          ? customPrompt.trim() 
          : `1. Resumo do Caso: O que o cliente solicitou e qual foi o motivo real do cancelamento/insatisfação alegado?
2. Tratativa de Retenção: O(s) Operador(es) Humano(s) aplicou(ram) techniques para reter o cliente? IMPORTANTE: O sistema/URA não realiza ofertas nem retém clientes. Foque a avaliação apenas na postura dos operadores humanos.
3. Tabulação: As tabulações aplicadas refletem corretamente o desfecho da conversa?
4. Feedback da IA: Apresente sua visão analítica. É um atendimento aprovado, passível de feedback ou crítico?`;

        const promptFinal = `Você é um auditor sênior de qualidade e retenção da empresa de telecomunicações Brisanet.
DADOS DA INTERAÇÃO NO SISTEMA:
- Nome capturado: ${cliente} | Operadores: ${agente} | Tabulações: ${wrapup.replace(/<[^>]*>/g, '')}
TRANSCRIÇÃO DO ATENDIMENTO:
${transcricao}
INSTRUÇÕES DE ANÁLISE:
${instrucoesDinamicas}

REGRAS DE FORMATAÇÃO — SIGA EXATAMENTE ESTA ESTRUTURA:
Sua resposta DEVE começar com exatamente estas duas linhas (sem texto antes, sem asteriscos, sem numeração):

CLIENTE: [nome real do cliente extraído da transcrição, ou a palavra: Não identificado]
DESFECHO: [escreva APENAS UMA das três opções a seguir, sem parênteses nem explicação adicional: Retido | Cancelado | Outro]

Em seguida, coloque exatamente três sinais de igual em uma linha separada:
===
[Depois do === escreva o relatório de auditoria em HTML simples usando: <h4>, <ul>, <li>, <p> e <strong>. Nunca use blocos de código]`;

        let iaResult = "";

        // 4. Disparo para as APIs (Gemini, Groq ou NVIDIA)
        try {
          if (provider === 'gemini') {
            const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey.trim()}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contents: [{ parts: [{ text: promptFinal }] }] })
            });
            if (!gRes.ok) throw new Error(`HTTP ${gRes.status}`);
            const gJson = await gRes.json();
            iaResult = gJson.candidates?.[0]?.content?.parts?.[0]?.text || "";
          } 
          else if (provider === 'groq') {
            const qRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + apiKey.trim(), 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: model, messages: [{ role: "user", content: promptFinal }], temperature: 0.2 })
            });
            if (!qRes.ok) throw new Error(`HTTP ${qRes.status}`);
            const qJson = await qRes.json();
            iaResult = qJson.choices?.[0]?.message?.content || "";
          }
          else if (provider === 'nvidia') {
            const nRes = await fetch(`https://api.nvidia.com/v1/chat/completions`, {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + apiKey.trim(), 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: model, messages: [{ role: "user", content: promptFinal }], temperature: 0.2, max_tokens: 2048 })
            });
            if (!nRes.ok) throw new Error(`HTTP ${nRes.status}`);
            const nJson = await nRes.json();
            iaResult = nJson.choices?.[0]?.message?.content || "";
          }
        } catch (e) {
          return res.status(200).json({ ok: false, erro: `Falha de comunicação com a IA (${provider}): ` + e.message });
        }

        // 5. Parser de Cabeçalho Estruturado (Portado e Otimizado do seu Code.gs)
        iaResult = iaResult.replace(/```html/g, '').replace(/```/g, '').trim();
        iaResult = iaResult.replace(/\*\*(CLIENTE:|DESFECHO:)\*\*/gi, '$1').replace(/\*(CLIENTE:|DESFECHO:)\*/gi, '$1');

        let nomeClienteFinal = cliente;
        let htmlFinal = iaResult;
        let statusLote = "Outro";

        if (iaResult.includes('===')) {
          let idxSep = iaResult.indexOf('===');
          let cabecalho = iaResult.substring(0, idxSep).trim();
          htmlFinal = iaResult.substring(idxSep + 3).trim();

          cabecalho.split('\n').forEach(linha => {
            let lUpper = linha.trim().toUpperCase();
            if (lUpper.startsWith('CLIENTE:')) {
              let extraido = linha.substring(linha.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '').replace(/\*+/g, '').trim();
              if (extraido && !['não identificado', 'desconhecido', 'cliente'].includes(extraido.toLowerCase())) {
                nomeClienteFinal = extraido;
              }
            }
            if (lUpper.startsWith('DESFECHO:')) {
              let dRaw = linha.substring(linha.indexOf(':') + 1).trim().replace(/\*+/g, '').replace(/[()\[\]]/g, '').trim().toUpperCase();
              if (dRaw.includes('RETID')) statusLote = 'Retido';
              else if (dRaw.includes('CANCEL')) statusLote = 'Cancelado';
            }
          });
        }

        return res.status(200).json({ 
          ok: true, 
          relatorioHTML: htmlFinal, 
          cliente: nomeClienteFinal, 
          agente: agente, 
          wrapup: wrapup, 
          desfechoLote: statusLote, 
          id: conversationId 
        });
      }

      case 'auditarPausasWFM': {
        const { groupId, userId, intervaloIso } = req.body;
        const TOLERANCIA_GERAL_MS = 2 * 60000;

        const dicPresencas = {};
        const resPres = await callGenesys('/api/v2/presencedefinitions?pageSize=100');
        if (resPres.entities) {
          resPres.entities.forEach(p => {
            let pName = p.name;
            if (p.languageLabels) {
              if (p.languageLabels["pt-BR"]) pName = p.languageLabels["pt-BR"];
              else if (p.languageLabels["pt_BR"]) pName = p.languageLabels["pt_BR"];
            }
            dicPresencas[p.id] = pName;
          });
        }
        const traducoesPadrao = { "ON_QUEUE": "Fila", "AVAILABLE": "Disponível", "AWAY": "Ausente", "BREAK": "Pausa Auricular", "MEAL": "Refeição", "MEETING": "Reunião", "TRAINING": "Treinamento", "BUSY": "Ocupado" };

        let mapeamentoEquipeCompleta = [];
        if (userId) {
          try {
            const rSingle = await callGenesys(`/api/v2/users/${userId}`);
            if (!rSingle.erro) mapeamentoEquipeCompleta.push({ id: rSingle.id, nome: rSingle.name });
          } catch {}
        } else {
          const dg = await callGenesys(`/api/v2/teams/${groupId}/members?pageSize=100`);
          if (dg.entities) {
            const idsWfm = dg.entities.map(m => (m.user && m.user.id) || m.id).filter(Boolean);
            if (idsWfm.length > 0) {
              const idsQWfm = idsWfm.map(id => `id=${encodeURIComponent(id)}`).join('&');
              const rNamesWfm = await callGenesys(`/api/v2/users?pageSize=100&${idsQWfm}`);
              const nomeMapWfm = {};
              if (rNamesWfm.entities) rNamesWfm.entities.forEach(u => { if (u.id) nomeMapWfm[u.id] = u.name || u.id; });
              idsWfm.forEach(id => mapeamentoEquipeCompleta.push({ id, nome: nomeMapWfm[id] || id }));
            }
          }
        }

        if (mapeamentoEquipeCompleta.length === 0) return res.status(200).json({ ok: true, dados: [] });

        const payloadWfm = {
          "interval": intervaloIso,
          "userFilters": [{ "type": "or", "predicates": mapeamentoEquipeCompleta.map(m => ({ "dimension": "userId", "value": m.id })) }]
        };

        const dataQuery = await callGenesys('/api/v2/analytics/users/details/query', 'post', payloadWfm);
        let timelinePorUsuario = {};

        if (!dataQuery.erro && dataQuery.userDetails) {
          dataQuery.userDetails.forEach(u => {
            let historicoPausas = [];
            if (u.primaryPresence) {
              u.primaryPresence.forEach(pres => {
                let pDefId = pres.presenceDefinitionId;
                let nomeStatus = dicPresencas[pDefId] || traducoesPadrao[pres.systemPresence] || pres.systemPresence;
                
                if (pres.systemPresence !== "AVAILABLE" && pres.systemPresence !== "OFFLINE" && pres.systemPresence !== "ON_QUEUE") {
                  let inicio = new Date(pres.startTime);
                  let fim = pres.endTime ? new Date(pres.endTime) : new Date();
                  let duracaoMs = fim.getTime() - inicio.getTime();

                  if (duracaoMs > 0) {
                    let tempoTotalMin = Math.floor(duracaoMs / 60000);
                    let estourou = false; let tempoEstouroMin = 0;
                    let sysUpper = pres.systemPresence.toUpperCase();
                    let nomeUpper = nomeStatus.toUpperCase();

                    if (sysUpper === "BREAK" || nomeUpper.includes("AURICULAR") || nomeUpper.includes("PAUSA 10")) {
                      if (duracaoMs > (10 * 60000) + TOLERANCIA_GERAL_MS) {
                        estourou = true; 
                        tempoEstouroMin = Math.floor((duracaoMs - (10 * 60000)) / 60000);
                      }
                    } else if (sysUpper === "MEAL" || nomeUpper.includes("REFEIÇÃO") || nomeUpper.includes("ALMOÇO")) {
                      if (duracaoMs > (20 * 60000) + TOLERANCIA_GERAL_MS) {
                        estourou = true; 
                        tempoEstouroMin = Math.floor((duracaoMs - (20 * 60000)) / 60000);
                      }
                    }

                    historicoPausas.push({
                      status: nomeStatus,
                      inicio: inicio.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
                      fim: pres.endTime ? fim.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : "Ainda em Pausa",
                      tempoTotalMin: tempoTotalMin,
                      estourou: estourou,
                      tempoEstouroMin: tempoEstouroMin
                    });
                  }
                }
              });
            }
            timelinePorUsuario[u.userId] = { pausas: historicoPausas };
          });
        }

        let resultadoFinal = mapeamentoEquipeCompleta.map(ag => {
          let tData = timelinePorUsuario[ag.id] || { pausas: [] };
          return {
            userId: ag.id, 
            nome: ag.nome, 
            pausas: tData.pausas,
            totalEstourosNoPeriodo: tData.pausas.filter(p => p.estourou).length
          };
        });

        resultadoFinal.sort((a, b) => b.totalEstourosNoPeriodo - a.totalEstourosNoPeriodo || a.nome.localeCompare(b.nome));
        return res.status(200).json({ ok: true, dados: resultadoFinal });
      }
case 'buscarAgentesPorPausa': {
        const { groupId: bpGroupId, intervaloIso: bpIntervalo } = req.body;

        // 1. Buscar TODAS as definições de presença (para nomear as pausas corretamente)
        const dicPresencasBP = {};
        let pPage = 1;
        let temMaisPresencas = true;
        while (temMaisPresencas) {
          const resPres2 = await callGenesys(`/api/v2/presencedefinitions?pageSize=100&pageNumber=${pPage}`);
          if (resPres2.entities && resPres2.entities.length > 0) {
            resPres2.entities.forEach(p => {
              let pName = p.name;
              if (p.languageLabels && p.languageLabels["pt-BR"]) pName = p.languageLabels["pt-BR"];
              else if (p.languageLabels && p.languageLabels["pt_BR"]) pName = p.languageLabels["pt_BR"];
              dicPresencasBP[p.id] = pName;
            });
            if (resPres2.entities.length < 100) temMaisPresencas = false;
            else pPage++;
          } else {
            temMaisPresencas = false;
          }
        }

        // 2. Buscar IDs dos membros da equipe
        let membrosIds = [];
        if (bpGroupId) {
          let tmPage = 1;
          let tmHasMore = true;
          while (tmHasMore) {
            const dg2 = await callGenesys(`/api/v2/teams/${bpGroupId}/members?pageSize=100&pageNumber=${tmPage}`);
            if (dg2.entities && dg2.entities.length > 0) {
              dg2.entities.forEach(m => {
                let id = (m.user && m.user.id) || m.id;
                if (id) membrosIds.push(id);
              });
              if (dg2.entities.length < 100) tmHasMore = false;
              else tmPage++;
            } else {
              tmHasMore = false;
            }
          }
        }

        membrosIds = [...new Set(membrosIds)];
        if (membrosIds.length === 0) return res.status(200).json({ ok: true, pausas: [], agentesMap: {}, membros: [] });

        // 3. Buscar nomes reais fatiados
        let membros = [];
        for (let i = 0; i < membrosIds.length; i += 50) {
          const chunkIds = membrosIds.slice(i, i + 50);
          const qs = chunkIds.map(id => `id=${encodeURIComponent(id)}`).join('&');
          const rUsers = await callGenesys(`/api/v2/users?pageSize=100&${qs}`);
          if (rUsers.entities) {
            rUsers.entities.forEach(u => {
               if (u.id) membros.push({ id: u.id, nome: u.name || u.id });
            });
          } else {
             chunkIds.forEach(id => membros.push({ id, nome: id }));
          }
        }

        const nomeMap = {};
        membros.forEach(m => { nomeMap[m.id] = m.nome; });

        // 4. ABORDAGEM INDIVIDUAL: Consultar o cronograma de CADA agente, um por um (lotes de 5 para performance)
        let allUserDetails = [];
        const chunkSize = 5; 
        
        for (let i = 0; i < membros.length; i += chunkSize) {
          const pedaco = membros.slice(i, i + chunkSize);
          
          // Promise.all executa as 5 consultas individuais ao mesmo tempo
          const promessas = pedaco.map(async (m) => {
             let pageNum = 1;
             let hasMore = true;
             let agentDetails = null;

             while (hasMore) {
                const payload = {
                  "interval": bpIntervalo,
                  "paging": { "pageSize": 100, "pageNumber": pageNum },
                  // Consulta EXCLUSIVA para o agente atual
                  "userFilters": [{
                      "type": "or",
                      "predicates": [{ "type": "dimension", "dimension": "userId", "value": m.id }]
                  }]
                };
                
                const res = await callGenesys('/api/v2/analytics/users/details/query', 'post', payload);
                if (res.erro || !res.userDetails || res.userDetails.length === 0) {
                  hasMore = false;
                } else {
                  if (!agentDetails) {
                    agentDetails = res.userDetails[0];
                  } else if (res.userDetails[0].primaryPresence) {
                    agentDetails.primaryPresence = (agentDetails.primaryPresence || []).concat(res.userDetails[0].primaryPresence);
                  }
                  
                  if (!res.userDetails[0].primaryPresence || res.userDetails[0].primaryPresence.length < 100) {
                     hasMore = false;
                  } else {
                     pageNum++;
                  }
                }
             }
             return agentDetails;
          });

          // Aguarda o lote de 5 agentes terminar e os insere na lista final
          const resultadosLote = await Promise.all(promessas);
          resultadosLote.forEach(det => {
            if (det) allUserDetails.push(det);
          });
        }

        // 5. Processar os eventos cronológicos de cada um
        const pausaMap = {}; 
        
        allUserDetails.forEach(u => {
          const nomeAgente = nomeMap[u.userId] || u.userId;
          (u.primaryPresence || []).forEach(pres => {
            // Busca o ID correto da subpausa
            let pDefId = pres.organizationPresenceId || pres.presenceDefinitionId;
            const traducoesPadrao = { "AWAY": "Ausente", "BREAK": "Pausa Auricular", "MEAL": "Refeição", "MEETING": "Reunião", "TRAINING": "Treinamento", "BUSY": "Ocupado" };
            let nomeStatus = dicPresencasBP[pDefId] || traducoesPadrao[pres.systemPresence] || pres.systemPresence;

            // Remove os status padrões de rotina do sistema, focando só nas pausas
            const statusUp = nomeStatus.toUpperCase();
            if (['AVAILABLE', 'DISPONÍVEL', 'ON_QUEUE', 'ON QUEUE', 'FILA', 'OFFLINE', 'OFF-LINE'].includes(statusUp)) {
                return;
            }

            const inicio = new Date(pres.startTime);
            const fim = pres.endTime ? new Date(pres.endTime) : new Date();
            const duracaoMs = fim.getTime() - inicio.getTime();
            if (duracaoMs <= 0) return;
            const duracaoMin = Math.floor(duracaoMs / 60000);

            if (!pausaMap[nomeStatus]) pausaMap[nomeStatus] = [];
            pausaMap[nomeStatus].push({
              userId: u.userId,
              nome: nomeAgente,
              inicio: inicio.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
              fim: pres.endTime ? fim.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'Em andamento',
              duracaoMin
            });
          });
        });

        // 6. Consolidar os dados para enviar ao painel
        const resultado = {};
        Object.keys(pausaMap).forEach(pausaNome => {
          const porAgente = {};
          pausaMap[pausaNome].forEach(e => {
            if (!porAgente[e.userId]) {
              porAgente[e.userId] = { userId: e.userId, nome: e.nome, ocorrencias: 0, totalMin: 0, registros: [] };
            }
            porAgente[e.userId].ocorrencias++;
            porAgente[e.userId].totalMin += e.duracaoMin;
            porAgente[e.userId].registros.push({ inicio: e.inicio, fim: e.fim, duracaoMin: e.duracaoMin });
          });
          resultado[pausaNome] = Object.values(porAgente).sort((a, b) => b.totalMin - a.totalMin);
        });

        const pausasOrdenadas = Object.keys(resultado).sort();
        return res.status(200).json({ ok: true, pausas: pausasOrdenadas, agentesMap: resultado, membros: membros });
      }

case 'buscarConversasParaLote': {
        const { queueId, wrapupId, intervaloIso, limite } = req.body;
        
        // 1. Monta os predicados no nível de Segmento (idêntico ao Code.gs original)
        const predicates = [
          { "type": "dimension", "dimension": "queueId", "value": queueId }
        ];
        
        // Se houver filtro de tabulação na tela, injeta no array
        if (wrapupId) {
          predicates.push({ "type": "dimension", "dimension": "wrapUpCode", "value": wrapupId });
        }

        const payload = {
          "interval": intervaloIso,
          "segmentFilters": [
            { 
              "type": "and", 
              "predicates": predicates 
            },
            {
              // Filtro de Mídia Digital unificado no nível de segmento para evitar o erro 404
              "type": "or",
              "predicates": [
                { "type": "dimension", "dimension": "mediaType", "value": "message" },
                { "type": "dimension", "dimension": "mediaType", "value": "chat" }
              ]
            }
          ],
          "paging": { 
            "pageSize": parseInt(limite) || 10, 
            "pageNumber": 1 
          }
        };

        const data = await callGenesys('/api/v2/analytics/conversations/details/query', 'post', payload);
        
        // Se a API falhar ou vier vazia, previne quebra devolvendo array vazio
        if (data.erro || !data.conversations) {
          return res.status(200).json({ ok: true, ids: [] });
        }

        const ids = data.conversations.map(c => c.conversationId);
        return res.status(200).json({ ok: true, ids: ids });
      }        
      default:
        return res.status(404).json({ erro: `Ação operacional '${action}' desconhecida no roteador.` });
    }
  } catch (e) {
    return res.status(200).json({ erro: 'Exceção capturada no Roteador: ' + e.message });
  }
}
