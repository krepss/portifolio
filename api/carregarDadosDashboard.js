export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const { token, baseUrl, queueId, groupId, intervaloIso, ehHoje } = req.body;
  if (!token) return res.status(401).json({ erro: 'Token ausente.' });
  if (!queueId) return res.status(400).json({ erro: 'Nenhuma fila informada.' });
  if (!intervaloIso) return res.status(400).json({ erro: 'Nenhum intervalo informado.' });

  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');

  // Helper interno para requisições no Genesys
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
    // 1. Membros do Grupo (Se houver)
    let membrosGrupo = null;
    if (groupId) {
      const resGrupo = await callGenesys(`/api/v2/teams/${groupId}/members?pageSize=100`);
      if (resGrupo && !resGrupo.erro && resGrupo.entities) membrosGrupo = resGrupo.entities.map(m => m.id);
    }

    // 2. Dicionário de Presenças
    const dicPresencas = {};
    const resPres = await callGenesys('/api/v2/presencedefinitions?pageSize=100');
    if (resPres && !resPres.erro && resPres.entities) {
      resPres.entities.forEach(pItem => {
        let pName = pItem.name;
        if (pItem.languageLabels) {
          if (pItem.languageLabels["pt-BR"]) pName = pItem.languageLabels["pt-BR"];
          else if (pItem.languageLabels["pt_BR"]) pName = pItem.languageLabels["pt_BR"];
        }
        dicPresencas[pItem.id] = pName;
      });
    }

    const traducoesPadrao = {
      "Available": "Disponível", "Break": "Pausa Básica", "Meal": "Pausa Refeição",
      "Meeting": "Reunião", "Training": "Treinamento", "Away": "Ausente do PC", "Busy": "Ocupado"
    };

    // 3. Usuários da Fila
    let agentes = [];
    let paginaAtual = 1;
    let temMaisDados = true;
    let interagindoAgoraGlobal = 0;

    while (temMaisDados) {
      const rUsers = await callGenesys(`/api/v2/routing/queues/${queueId}/members?expand=presence&expand=routingStatus&expand=conversationSummary&pageSize=100&pageNumber=${paginaAtual}`);
      if (rUsers.erro || !rUsers.entities) { temMaisDados = false; continue; }

      rUsers.entities.forEach(member => {
        let uObj = member.user || member;
        let userId = uObj.id || member.id;
        if (membrosGrupo && membrosGrupo.indexOf(userId) === -1) return;

        let rStatusObj = member.routingStatus || uObj.routingStatus || {};
        let rStatus = rStatusObj.status || "UNKNOWN";
        let presenceObj = member.presence || uObj.presence || {};
        let presenceDef = presenceObj.presenceDefinition || {};
        let sysPresence = presenceDef.systemPresence || "Offline";
        let modifiedDate = presenceObj.modifiedDate || member.modifiedDate || new Date().toISOString();
        let nomeAgente = member.name || uObj.name || "Operador Desconhecido";

        let convSummary = member.conversationSummary || uObj.conversationSummary || null;
        let qtdInteracoes = 0;
        if (convSummary) {
          ['call', 'callback', 'chat', 'email', 'message', 'socialExpression', 'video'].forEach(c => {
            if (convSummary[c]) {
              if (typeof convSummary[c].contactCenter === 'object' && convSummary[c].contactCenter.active) qtdInteracoes += convSummary[c].contactCenter.active;
              if (typeof convSummary[c].enterprise === 'object' && convSummary[c].enterprise.active) qtdInteracoes += convSummary[c].enterprise.active;
            }
          });
        }
        interagindoAgoraGlobal += qtdInteracoes;

        let statusAmigavel = "Offline"; let prioridade = 4; let tipoClass = "offline";
        if (sysPresence !== "Offline") {
          if (sysPresence === "On Queue") {
            if (rStatus === "INTERACTING" || rStatus === "COMMUNICATING") { statusAmigavel = "Em Atendimento"; prioridade = 3; tipoClass = "busy"; }
            else if (rStatus === "NOT_RESPONDING") { statusAmigavel = "Não Respondendo"; prioridade = 1; tipoClass = "away"; }
            else { statusAmigavel = "Disponível"; prioridade = 3; tipoClass = "available"; }
          } else {
            prioridade = 2;
            let statusSecundario = dicPresencas[presenceDef.id] || presenceDef.name || "";
            if (statusSecundario) { statusAmigavel = traducoesPadrao[statusSecundario] || statusSecundario; }
            else { statusAmigavel = traducoesPadrao[sysPresence] || sysPresence; }

            if (sysPresence === "Available" || sysPresence === "Interacting") {
               if (sysPresence === "Interacting") statusAmigavel = "Fora da Fila / Pessoal";
               tipoClass = "acw";
            } else { tipoClass = "break"; }
          }
        }

        agentes.push({
          id: userId, nome: nomeAgente, status: statusAmigavel, sysClass: tipoClass, prioridade: prioridade,
          pausaMs: Date.now() - new Date(modifiedDate).getTime(), interagindo: qtdInteracoes, email: uObj.email || ''
        });
      });

      if (!rUsers.nextUri) temMaisDados = false; else paginaAtual++;
    }

    // 4. Observações de Fila
    let esperandoAgora = 0;
    const payloadObsFila = { "filter": { "type": "and", "predicates": [ { "type": "dimension", "dimension": "queueId", "value": queueId } ] }, "metrics": ["oWaiting"] };
    const rObsFila = await callGenesys('/api/v2/analytics/queues/observations/query', 'post', payloadObsFila);
    if (rObsFila && !rObsFila.erro && rObsFila.results && rObsFila.results[0] && rObsFila.results[0].data) {
      rObsFila.results[0].data.forEach(d => { if(d.metric === 'oWaiting') esperandoAgora = d.stats.count || 0; });
    }

    // 5. Agregados da Fila
    const payloadAggFila = { "interval": intervaloIso, "groupBy": ["queueId", "mediaType"], "filter": { "type": "and", "predicates": [ { "type": "dimension", "dimension": "queueId", "value": queueId } ] }, "metrics": ["tAnswered", "tHandle", "tAcw", "oServiceLevel", "nOffered", "tAbandon", "tWait"] };
    const rAggFila = await callGenesys('/api/v2/analytics/conversations/aggregates/query', 'post', payloadAggFila);
    let resultFila = { slaNumerator: 0, slaDenominator: 0, slaRatioFallback: null, sumTAnswered: 0, countTAnswered: 0, sumTHandle: 0, countTHandle: 0, sumTAcw: 0, countTAcw: 0, sumTWait: 0, countTWait: 0, nOfertadas: 0, nAbandonadas: 0 };

    if (rAggFila && !rAggFila.erro && rAggFila.results) {
      rAggFila.results.forEach(resGrp => {
        if (resGrp.data) {
          resGrp.data.forEach(dData => {
            if (dData.metrics) {
              dData.metrics.forEach(m => {
                if (m.metric === "tAnswered") { resultFila.sumTAnswered += m.stats.sum||0; resultFila.countTAnswered += m.stats.count||0; }
                if (m.metric === "tHandle") { resultFila.sumTHandle += m.stats.sum||0; resultFila.countTHandle += m.stats.count||0; }
                if (m.metric === "tAcw") { resultFila.sumTAcw += m.stats.sum||0; resultFila.countTAcw += m.stats.count||0; }
                if (m.metric === "tWait") { resultFila.sumTWait += m.stats.sum||0; resultFila.countTWait += m.stats.count||0; }
                if (m.metric === "nOffered") { resultFila.nOfertadas += m.stats.count||0; }
                if (m.metric === "tAbandon") { resultFila.nAbandonadas += m.stats.count||0; }
                if (m.metric === "oServiceLevel" && m.stats) {
                  resultFila.slaNumerator += m.stats.numerator||0;
                  resultFila.slaDenominator += m.stats.denominator||0;
                  if (m.stats.ratio !== undefined) resultFila.slaRatioFallback = m.stats.ratio;
                }
              });
            }
          });
        }
      });
    }

    // 6. Agregados dos Agentes
    const payloadAggAgentes = { "interval": intervaloIso, "groupBy": ["userId", "mediaType"], "filter": { "type": "and", "predicates": [ { "type": "dimension", "dimension": "queueId", "value": queueId } ] }, "metrics": ["tHandle", "tAcw", "tHeld", "nTransferred"] };
    const rAggAgentes = await callGenesys('/api/v2/analytics/conversations/aggregates/query', 'post', payloadAggAgentes);
    let mapAgentes = {};

    if (rAggAgentes && !rAggAgentes.erro && rAggAgentes.results) {
      rAggAgentes.results.forEach(resGrp => {
        let uid = resGrp.group && resGrp.group.userId; let mType = resGrp.group && resGrp.group.mediaType;
        if (uid && resGrp.data) {
          if (!mapAgentes[uid]) mapAgentes[uid] = { handCnt:0, handSum:0, handVoice:0, handDigital:0, acwSum:0, heldSum:0, trans:0 };
          resGrp.data.forEach(d => {
            if (d.metrics) {
              d.metrics.forEach(m => {
                if (m.metric === "tHandle") {
                  let count = m.stats.count || 0; mapAgentes[uid].handCnt += count; mapAgentes[uid].handSum += m.stats.sum || 0;
                }
                if (m.metric === "tAcw") mapAgentes[uid].acwSum += m.stats.sum||0;
                if (m.metric === "tHeld") mapAgentes[uid].heldSum += m.stats.sum||0;
                if (m.metric === "nTransferred") mapAgentes[uid].trans += m.stats.count||0;
              });
            }
          });
        }
      });
    }

    // 7. Consolidação
    agentes.forEach(a => {
       let st = mapAgentes[a.id] || { handCnt:0, handSum:0, handVoice:0, handDigital:0, acwSum:0, heldSum:0, trans:0 };
       a.atendidas = st.handCnt;
       a.aht = st.handCnt > 0 ? Math.round(st.handSum / st.handCnt / 1000) : 0;
       a.acwMedio = st.handCnt > 0 ? Math.round(st.acwSum / st.handCnt / 1000) : 0;
       a.tmeMedio = st.handCnt > 0 ? Math.round(st.heldSum / st.handCnt / 1000) : 0;
       a.transferencias = st.trans;
    });

    let slaFinal = 100.0;
    if (resultFila.slaDenominator > 0) { slaFinal = (resultFila.slaNumerator / resultFila.slaDenominator) * 100; }
    else if (resultFila.slaRatioFallback !== null) { slaFinal = resultFila.slaRatioFallback * 100; }

    let nAtendidas = resultFila.countTAnswered;
    let vmaCalculado = nAtendidas > 0 ? Math.round(resultFila.sumTAnswered / nAtendidas / 1000) : 0;
    let tmeCalculado = resultFila.countTWait > 0 ? Math.round(resultFila.sumTWait / resultFila.countTWait / 1000) : 0;
    let tmaCalculado = resultFila.countTHandle > 0 ? Math.round(resultFila.sumTHandle / resultFila.countTHandle / 1000) : 0;
    let tpcCalculado = resultFila.countTHandle > 0 ? Math.round(resultFila.sumTAcw / resultFila.countTHandle / 1000) : 0;

    return res.status(200).json({
      ok: true, isRealTime: ehHoje,
      fila: {
        emEspera: esperandoAgora, ativasAgora: interagindoAgoraGlobal, nOfertadas: resultFila.nOfertadas,
        nAtendidas: nAtendidas, nAbandonadas: resultFila.nAbandonadas,
        taxaAbandono: resultFila.nOfertadas > 0 ? ((resultFila.nAbandonadas / resultFila.nOfertadas) * 100).toFixed(1) : '0.0',
        sla: slaFinal.toFixed(1), vma: vmaCalculado, tme: tmeCalculado, tma: tmaCalculado, tpc: tpcCalculado
      },
      agentes: agentes,
      timestamp: new Date().toISOString()
    });

  } catch (e) {
    return res.status(500).json({ erro: 'Falha no servidor: ' + String(e) });
  }
}
