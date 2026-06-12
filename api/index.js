export default async function handler(req, res) {
  // Configuração Global de Headers CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  // Captura o endpoint dinâmico enviado pelo frontend através da URL ou do corpo
  // Ajustado para ler a rota tanto pela URL (ex: /api?action=listarFilas) quanto adaptado pelo arquivo index.html
  const urlParts = req.url.split('?');
  const actionPath = urlParts[0].replace('/api/', '').replace('/api', '').trim();
  const action = actionPath || req.query.action || req.body.action;

  const { token, baseUrl } = req.body;
  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');

  // Helper interno universal para requisições no Genesys Cloud
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

  // SWITCH CENTRALIZADO DE ROTAS (Reduz para 1 única Serverless Function na Vercel)
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
        // Faz a chamada para a API de membros da equipa do Genesys
        const data = await callGenesys(`/api/v2/teams/${teamId}/members?pageSize=100`);
        if (data.erro || !data.entities) return res.status(200).json({ membros: [] });
        
        const membrosFiltrados = data.entities
          .map(m => {
            // Correção Crítica: No Genesys Cloud, os dados do agente vêm dentro do objeto 'user'
            let userObj = m.user || {};
            let idDetectado = userObj.id || m.id || '';
            let nomeDetectado = userObj.name || m.name || 'Operador Desconhecido';
            
            return {
              id: idDetectado,
              nome: nomeDetectado,
              name: nomeDetectado
            };
          })
          // Filtra para garantir que não entram registos vazios ou falhados
          .filter(m => m.id !== '' && m.nome !== 'Operador Desconhecido');
        
        // Ordena de A-Z pelo nome dos agentes
        membrosFiltrados.sort((a, b) => a.nome.localeCompare(b.nome));
        
        return res.status(200).json({ membros: membrosFiltrados });
      }
      case 'carregarDadosDashboard': {
        const { queueId, groupId, intervaloIso, ehHoje } = req.body;
        let membrosGrupo = null;
        if (groupId) {
          const resGrupo = await callGenesys(`/api/v2/teams/${groupId}/members?pageSize=100`);
          if (resGrupo.entities) membrosGrupo = resGrupo.entities.map(m => m.id);
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
          if (rUsers.erro || !rUsers.entities) break;
          rUsers.entities.forEach(member => {
            let uObj = member.user || member; let userId = uObj.id || member.id;
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
            if (m.metric === "tHandle") { k.atendidas += m.stats.count||0; k.atendidasVoice += m.stats.count||0; k.aht = m.stats.count > 0 ? Math.round(m.stats.sum/m.stats.count/1000) : 0; }
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
        
        // 1. Busca os membros da fila atual para criar um cache de Nome Real baseado no ID
        const cacheNomesOutbound = {};
        try {
          const rUsersFila = await callGenesys(`/api/v2/routing/queues/${idFila}/members?pageSize=100`);
          if (rUsersFila.entities) {
            rUsersFila.entities.forEach(m => {
              let uObj = m.user || m || {};
              if (uObj.id) cacheNomesOutbound[uObj.id] = uObj.name || m.name || "Operador";
            });
          }
        } catch (e) { console.error("Erro ao montar cache outbound:", e); }

        // 2. Executa a query de detalhes de conversações outbound
        const r = await callGenesys("/api/v2/analytics/conversations/details/query", "post", { 
          "interval": intervaloStr, 
          "segmentFilters": [{ 
            "type": "and", 
            "predicates": [ 
              {"dimension": "mediaType", "value": "voice"}, 
              {"dimension": "direction", "value": "outbound"}, 
              {"dimension": "queueId", "value": idFila} 
            ] 
          }], 
          "paging": {"pageSize": 100, "pageNumber": 1} 
        });
        
        let arr = [];
        if (r.conversations) {
          r.conversations.forEach(c => {
            let num = c.participants?.find(p => p.purpose === 'customer')?.sessions?.[0]?.dnis || 'N/A';
            let agId = c.participants?.find(p => p.purpose === 'agent')?.userId || 'Desconhecido';
            
            // CONVERSÃO CRÍTICA: Busca o nome real do cache; se não achar, exibe o ID encurtado
            let nomeExibicaoAgente = cacheNomesOutbound[agId] || (agId !== 'Desconhecido' ? "Agente (" + agId.substring(0,5) + ")" : "Desconhecido");
            
            arr.push({ 
              data: new Date(c.conversationStart).toLocaleDateString('pt-BR'), 
              ddd: '88', 
              numero: num, 
              agente: nomeExibicaoAgente, 
              wrapup: 'Outbound', 
              tentativas: 1, 
              detalhes: [] 
            });
          });
        }
        return res.status(200).json({ error: false, data: arr.filter(x => x.numero !== 'N/A') });
      }

      case 'buscarWrapupsDaFila': {
        const { queueId } = req.body;
        const data = await callGenesys(`/api/v2/routing/queues/${queueId}/wrapupcodes?pageSize=100`);
        if (!data.entities) return res.status(200).json([]);
        return res.status(200).json(data.entities.map(w => ({ id: w.id, nome: w.name })));
      }

      case 'buscarConversasPara Lote': {
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

      case 'auditarPausasWFM': {
        const { groupId, userId, intervaloIso } = req.body;
        const TOLERANCIA_GERAL_MS = 2 * 60000; // 2 minutos de tolerância fixa

        // 1. Dicionário de presenças para traduzir os IDs internos em strings limpas
        const dicPresencas = {};
        const resPres = await callGenesys('/api/v2/presencedefinitions?pageSize=100');
        if (resPres.entities) {
          resPres.entities.forEach(p => {
            dicPresencas[p.id] = (p.languageLabels && (p.languageLabels["pt-BR"] || p.languageLabels["pt_BR"])) || p.name;
          });
        }
        const traducoesPadrao = { "ON_QUEUE": "Fila", "AVAILABLE": "Disponível", "AWAY": "Ausente", "BREAK": "Pausa Auricular", "MEAL": "Refeição", "MEETING": "Reunião", "TRAINING": "Treinamento", "BUSY": "Ocupado" };

        // 2. Mapeia o cadastro completo dos alvos da equipe
        let mapeamentoEquipeCompleta = [];
        if (userId) {
          try {
            const rSingle = await callGenesys(`/api/v2/users/${userId}`);
            if (!rSingle.erro) mapeamentoEquipeCompleta.push({ id: rSingle.id, nome: rSingle.name || "Agente" });
          } catch {}
        } else {
          const dg = await callGenesys(`/api/v2/teams/${groupId}/members?pageSize=100`);
          if (dg.entities) {
            dg.entities.forEach(m => {
              let uObj = m.user || m || {};
              if (uObj.id) {
                mapeamentoEquipeCompleta.push({ 
                  id: uObj.id, 
                  nome: m.name || uObj.name || "Operador" 
                });
              }
            });
          }
        }

        if (mapeamentoEquipeCompleta.length === 0) {
          return res.status(200).json({ ok: true, dados: [] });
        }

        // 3. Executa a query de detalhes de presença na Timeline do Analytics do Genesys
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
                
                // Ignora estados comuns produtivos/offline
                if (pres.systemPresence !== "AVAILABLE" && pres.systemPresence !== "OFFLINE" && pres.systemPresence !== "ON_QUEUE") {
                  let inicio = new Date(pres.startTime);
                  let fim = pres.endTime ? new Date(pres.endTime) : new Date();
                  let duracaoMs = fim.getTime() - inicio.getTime();

                  if (duracaoMs > 0) {
                    let tempoTotalMin = Math.floor(duracaoMs / 60000);
                    let estourou = false;
                    let tempoEstouroMin = 0;

                    let sysUpper = pres.systemPresence.toUpperCase();
                    let nomeUpper = nomeStatus.toUpperCase();

                    // Regra rígida Brisanet: Pausa Auricular (10m + 2m) e Refeição (20m + 2m)
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

        // 4. União absoluta: Cruza a lista de pessoas do time com os dados extraídos
        let resultadoFinal = mapeamentoEquipeCompleta.map(agenteCadastro => {
          let dadosTimeline = timelinePorUsuario[agenteCadastro.id] || { pausas: [] };
          let listaDePausas = dadosTimeline.pausas;
          let totalEstouros = listaDePausas.filter(p => p.estourou).length;

          return {
            userId: agenteCadastro.id,
            nome: agenteCadastro.nome,
            pausas: listaDePausas,
            totalEstourosNoPeriodo: totalEstouros
          };
        });

        // Ordenação inteligente: Infratores graves no topo, seguidos por ordem alfabética dos demais
        resultadoFinal.sort((a, b) => {
          if (b.totalEstourosNoPeriodo !== a.totalEstourosNoPeriodo) {
            return b.totalEstourosNoPeriodo - a.totalEstourosNoPeriodo;
          }
          return a.nome.localeCompare(b.nome);
        });

        return res.status(200).json({ ok: true, dados: resultadoFinal });
      }

      default:
        return res.status(404).json({ erro: `Ação operacional '${action}' desconhecida no roteador.` });
    }
  } catch (e) {
    return res.status(200).json({ erro: 'Exceção capturada no Roteador: ' + e.message });
  }
}
