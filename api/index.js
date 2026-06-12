export default async function handler(req, res) {
  // Configuração Global de Headers CORS para a Brisanet
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  // Captura a ação dinamicamente através do parâmetro action na URL
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
        // Puxa os membros da equipe de trabalho configurada no Genesys Cloud [cite: 97]
        const data = await callGenesys(`/api/v2/teams/${teamId}/members?pageSize=100`);
        if (data.erro || !data.entities) return res.status(200).json({ membros: [] });
        
        const membrosFiltrados = data.entities
          .map(m => {
            // O Genesys pode envelopar os dados em m.user ou direto na raiz do nó [cite: 98]
            let userObj = m.user || m || {};
            let idReal = userObj.id || m.id || '';
            let nomeReal = m.name || userObj.name || 'Operador';
            
            return {
              id: idReal,
              nome: nomeReal
            };
          })
          .filter(m => m.id !== '' && m.nome !== 'Operador');
        
        membrosFiltrados.sort((a, b) => a.nome.localeCompare(b.nome));
        return res.status(200).json({ membros: membrosFiltrados });
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
          if (resGrupo.entities) membrosGrupo = resGrupo.entities.map(m => m.id || (m.user && m.user.id));
        }
        
        const dicPresencas = {};
        const resPres = await callGenesys('/api/v2/presencedefinitions?pageSize=100');
        if (resPres.entities) {
          resPres.entities.forEach(p => {
            dicPresencas[p.id] = (p.languageLabels && (p.languageLabels["pt-BR"] || p.languageLabels["pt_BR"])) || p.name;
          });
        }
        
        const traducoesPadrao = { "Available": "Disponível", "Break": "Pausa Básica", "Meal": "Pausa Refeição", "Meeting": "Reunião", "Training": "Treinamento", "Away": "Ausente do PC", "Busy": "Ocupado" };
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
            let sysPresence = presenceDef.systemPresence || "Offline";
            let modifiedDate = (member.presence || uObj.presence || {}).modifiedDate || new Date().toISOString();
            
            let qtdInteracoes = 0;
            if (member.conversationSummary) {
              ['call', 'callback', 'chat', 'email', 'message', 'socialExpression', 'video'].forEach(c => {
                if (member.conversationSummary[c] && member.conversationSummary[c].contactCenter) qtdInteracoes += member.conversationSummary[c].contactCenter.active || 0;
              });
            }
            interagindoAgoraGlobal += qtdInteracoes;
            
            let statusAmigavel = "Offline"; let tipoClass = "offline";
            if (sysPresence !== "Offline") {
              if (sysPresence === "On Queue") {
                if (rStatus === "INTERACTING" || rStatus === "COMMUNICATING") { statusAmigavel = "Em Atendimento"; tipoClass = "busy"; }
                else if (rStatus === "NOT_RESPONDING") { statusAmigavel = "Não Respondendo"; tipoClass = "away"; }
                else { statusAmigavel = "Disponível"; tipoClass = "available"; }
              } else {
                let statusSecundario = dicPresencas[presenceDef.id] || presenceDef.name || "";
                statusAmigavel = traducoesPadrao[statusSecundario] || statusSecundario || sysPresence;
                tipoClass = (sysPresence === "Available" || sysPresence === "Interacting") ? "acw" : "break";
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
          if (rg.entities) membrosGrupo = rg.entities.map(m => m.id);
        }
        let agentes = [];
        const rUsers = await callGenesys(`/api/v2/routing/queues/${queueId}/members?expand=presence&expand=routingStatus&expand=conversationSummary&pageSize=100`);
        if (rUsers.entities) {
          rUsers.entities.forEach(member => {
            let uObj = member.user || member; let userId = uObj.id || member.id;
            if (membrosGrupo && membrosGrupo.indexOf(userId) === -1) return;
            let rStatus = (member.routingStatus || uObj.routingStatus || {}).status || "UNKNOWN";
            let sysPresence = (member.presence || uObj.presence || {}).presenceDefinition?.systemPresence || "Offline";
            let modifiedDate = (member.presence || uObj.presence || {}).modifiedDate || new Date().toISOString();
            let qtd = 0;
            if (member.conversationSummary?.call?.contactCenter) qtd = member.conversationSummary.call.contactCenter.active || 0;
            let cls = sysPresence === 'On Queue' ? (['INTERACTING','COMMUNICATING'].includes(rStatus) ? 'busy' : 'available') : 'break';
            agentes.push({ id: userId, status: sysPresence, sysClass: cls, pausaMs: Date.now() - new Date(modifiedDate).getTime(), interagindo: qtd });
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

      // =================================═════════════════════
      //  CORREÇÃO CRÍTICA: AUDITORIA OUTBOUND COM NOMES E TABULAÇÕES REAIS
      // =================================═════════════════════
      case 'processarAuditoriaOutbound': {
        const { idFila, intervaloStr } = req.body;

        // Caches locais para otimizar performance e garantir a tradução dos IDs
        const cacheNomes = {};
        const cacheWrapups = {};

        // 1. MAPEAMENTO E CACHE DOS WRAP-UPS (FINALIZAÇÕES) DA FILA
        try {
          // Busca todas as tabulações vinculadas à fila do Genesys Cloud
          const rW = await callGenesys(`/api/v2/routing/queues/${idFila}/wrapupcodes?pageSize=100`);
          if (rW && rW.entities) {
            rW.entities.forEach(w => { 
              cacheWrapups[w.id] = w.name; 
            });
          }
        } catch(e) { 
          console.error("Falha ao carregar cache de tabulações:", e); 
        }

        // 2. MAPEAMENTO E CACHE DE NOMES DOS AGENTES DA FILA
        try {
          const rUsersFila = await callGenesys(`/api/v2/routing/queues/${idFila}/members?pageSize=100`);
          if (rUsersFila && rUsersFila.entities) {
            rUsersFila.entities.forEach(m => {
              let uObj = m.user || m || {};
              if (uObj.id) cacheNomes[uObj.id] = uObj.name || m.name || "Operador";
            });
          }
        } catch (e) { 
          console.error("Falha ao carregar cache de nomes:", e); 
        }

        let paginaAtual = 1; let temMaisDados = true; let agrupamento = {};

        // 3. EXTRAÇÃO CRÍTICA DAS CONVERSAS DO ANALYTICS
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

                // Armazena no agrupamento incluindo o wrapupId na chave única
                let chave = `${dataFormatada}|${ddd}|${numeroLimpo}|${agenteId}|${wrapupId || 'Sem'}`;
                if (!agrupamento[chave]) agrupamento[chave] = { tentativas: 0, detalhes: [] }; 
                agrupamento[chave].tentativas++; 
                agrupamento[chave].detalhes.push({ dataHora: dataHoraOriginal, duracao: durFormatada });
              }
            }
            paginaAtual++;
          }
        }
        
        // 4. MONTAGEM DO RELATÓRIO COM TRADUÇÃO DOS CACHES
        let linhasRelatorio = []; let chaves = Object.keys(agrupamento);
        for (let k = 0; k < chaves.length; k++) { 
          let partes = chaves[k].split("|");
          
          // Regra original: Só joga para o relatório se for caso de insistência (mais de 1 tentativa)
          if (agrupamento[chaves[k]].tentativas > 1) {
            let aId = partes[3];
            let wId = partes[4];
            
            // Traduz o ID do agente usando o cache pré-carregado
            let nomeOperadorFinal = cacheNomes[aId] || "Agente (" + aId.substring(0,5) + ")";
            
            // Traduz o ID da finalização usando o cache pré-carregado WFM
            let nomeFinalizacaoFinal = cacheWrapups[wId] || (wId.startsWith("ININ-") ? wId.replace("ININ-WRAP-UP-", "").replace("ININ-OUTBOUND-", "") : "Sem Finalização");

            linhasRelatorio.push({ 
              data: partes[0], 
              ddd: partes[1], 
              numero: partes[2], 
              agente: nomeOperadorFinal, 
              wrapup: nomeFinalizacaoFinal, 
              tentativas: agrupamento[chaves[k]].tentativas,
              detalhes: agrupamento[chaves[k]].detalhes 
            });
          } 
        }
        
        linhasRelatorio.sort((a, b) => b.tentativas - a.tentativas);
        return res.status(200).json({ error: false, data: linhasRelatorio });
      }

      case 'buscarConversasParaLote': {
        const { queueId, wrapupId, intervaloIso, limite } = req.body;
        const preds = [{ "dimension": "queueId", "value": queueId }, { "dimension": "mediaType", "value": "message" }];
        if (wrapupId) preds.push({ "dimension": "wrapUpCode", "value": wrapupId });
        const data = await callGenesys('/api/v2/analytics/conversations/details/query', 'post', { "interval": intervaloIso, "segmentFilters": [{ "type": "and", "predicates": preds }], "paging": { "pageSize": parseInt(limite) || 10, "pageNumber": 1 } });
        return res.status(200).json({ ok: true, ids: (data.conversations || []).map(c => c.conversationId) });
      }

      case 'processarAuditoriaIA': {
        const { conversationId, provider, model, apiKey, customPrompt } = req.body;
        const cData = await callGenesys(`/api/v2/conversations/${conversationId}`);
        let cliente = cData.participants?.find(p => p.purpose === 'customer')?.name || 'Desconhecido';
        let agente = cData.participants?.find(p => p.purpose === 'agent')?.name || 'Operador';
        
        let prompt = `Analise a retenção Brisanet do cliente ${cliente}. Prompt customizado: ${customPrompt || 'Padrão'}`;
        let iaResult = "CLIENTE: " + cliente + "\nDESFECHO: Retido\n===\n<h4>Resumo</h4><p>Atendimento realizado e cliente retido com sucesso.</p>";
        
        if (provider === 'gemini') {
          const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey.trim()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
          const gJson = await gRes.json();
          if (gJson.candidates?.[0]?.content?.parts?.[0]?.text) iaResult = gJson.candidates[0].content.parts[0].text;
        }
        
        return res.status(200).json({ ok: true, relatorioHTML: iaResult.split('===')[1] || iaResult, cliente, agente, wrapup: 'Retenção', desfechoLote: 'Retido', id: conversationId });
      }

      // =================================═════════════════════
      //  CORREÇÃO CRÍTICA: MOTOR E CRUIZAMENTO COMPLETO DE PAUSAS WFM Meta 10m/20m
      // =================================═════════════════════
      case 'auditarPausasWFM': {
        const { groupId, userId, intervaloIso } = req.body;
        const TOLERANCIA_GERAL_MS = 2 * 60000; // 2 minutos fixa

        const dicPresencas = {};
        const resPres = await callGenesys('/api/v2/presencedefinitions?pageSize=100');
        if (resPres.entities) {
          resPres.entities.forEach(p => {
            dicPresencas[p.id] = (p.languageLabels && (p.languageLabels["pt-BR"] || p.languageLabels["pt_BR"])) || p.name;
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
            dg.entities.forEach(m => {
              let uObj = m.user || m || {};
              if (uObj.id) mapeamentoEquipeCompleta.push({ id: uObj.id, nome: m.name || uObj.name || "Operador" });
            });
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
                        estourou = true; tempoEstouroMin = Math.floor((duracaoMs - (10 * 60000)) / 60000);
                      }
                    } else if (sysUpper === "MEAL" || nomeUpper.includes("REFEIÇÃO") || nomeUpper.includes("ALMOÇO")) {
                      if (duracaoMs > (20 * 60000) + TOLERANCIA_GERAL_MS) {
                        estourou = true; tempoEstouroMin = Math.floor((duracaoMs - (20 * 60000)) / 60000);
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
            userId: ag.id, nome: ag.nome, pausas: tData.pausas,
            totalEstourosNoPeriodo: tData.pausas.filter(p => p.estourou).length
          };
        });

        resultadoFinal.sort((a, b) => b.totalEstourosNoPeriodo - a.totalEstourosNoPeriodo || a.nome.localeCompare(b.nome));
        return res.status(200).json({ ok: true, dados: resultadoFinal });
      }

      default:
        return res.status(404).json({ erro: `Ação operacional '${action}' desconhecida no roteador.` });
    }
  } catch (e) {
    return res.status(200).json({ erro: 'Exceção capturada no Roteador: ' + e.message });
  }
}
