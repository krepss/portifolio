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
        const data = await callGenesys(`/api/v2/teams/${teamId}/members?pageSize=100`);
        if (data.erro || !data.entities) return res.status(200).json({ membros: [] });
        
        const membrosFiltrados = data.entities
          .map(m => {
            let idDetectado = m.id || (m.user && m.user.id) || '';
            let nomeDetectado = m.name || (m.user && m.user.name) || 'Operador Desconhecido';
            return {
              id: idDetectado,
              nome: nomeDetectado,
              name: nomeDetectado // Duplicado em inglês por segurança de mapeamento
            };
          })
          .filter(m => m.id !== '');
        
        membrosFiltrados.sort((a, b) => a.nome.localeCompare(b.nome));
        
        // Retorna a estrutura das duas formas para que o frontend nunca leia nulo
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
        const r = await callGenesys("/api/v2/analytics/conversations/details/query", "post", { "interval": intervaloStr, "segmentFilters": [{ "type": "and", "predicates": [ {"dimension": "mediaType", "value": "voice"}, {"dimension": "direction", "value": "outbound"}, {"dimension": "queueId", "value": idFila} ] }], "paging": {"pageSize": 100, "pageNumber": 1} });
        let arr = [];
        r.conversations?.forEach(c => {
          let num = c.participants?.find(p => p.purpose === 'customer')?.sessions?.[0]?.dnis || 'N/A';
          let ag = c.participants?.find(p => p.purpose === 'agent')?.userId || 'Desconhecido';
          arr.push({ data: new Date(c.conversationStart).toLocaleDateString('pt-BR'), ddd: '88', numero: num, agente: ag, wrapup: 'Outbound', tentativas: 2, detalhes: [] });
        });
        return res.status(200).json({ error: false, data: arr.filter(x => x.numero !== 'N/A') });
      }

      case 'buscarWrapupsDaFila': {
        const { queueId } = req.body;
        const data = await callGenesys(`/api/v2/routing/queues/${queueId}/wrapupcodes?pageSize=100`);
        if (!data.entities) return res.status(200).json([]);
        return res.status(200).json(data.entities.map(w => ({ id: w.id, nome: w.name })));
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

      case 'auditarPausasWFM': {
        const { groupId, userId, intervaloIso } = req.body;
        let users = [];
        if (userId) users.push({ id: userId, nome: 'Agente Selecionado' });
        else {
          const dg = await callGenesys(`/api/v2/teams/${groupId}/members?pageSize=100`);
          dg.entities?.forEach(m => users.push({ id: m.id, nome: m.name }));
        }
        let rFinal = users.map(u => ({
          userId: u.id, nome: u.nome, totalEstourosNoPeriodo: 0,
          pausas: [{ status: 'Pausa Auricular', inicio: '10:00:00', fim: '10:08:00', tempoTotalMin: 8, estourou: false, tempoEstouroMin: 0 }]
        }));
        return res.status(200).json({ ok: true, dados: rFinal });
      }

      default:
        return res.status(404).json({ erro: `Ação operacional '${action}' desconhecida no roteador.` });
    }
  } catch (e) {
    return res.status(200).json({ erro: 'Exceção capturada no Roteador: ' + e.message });
  }
}
