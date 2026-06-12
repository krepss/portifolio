export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });
  const { token, baseUrl, queueId, groupId } = req.body;
  if (!token || !queueId) return res.status(400).json({ erro: 'Parâmetros ausentes.' });

  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');

  async function callGenesys(path, method = 'get', payload = null) {
    const opts = { method: method.toUpperCase(), headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
    if (payload) opts.body = JSON.stringify(payload);
    const response = await fetch(`${cleanUrl}${path}`, opts);
    if (!response.ok) return { erro: `HTTP ${response.status}` };
    return await response.json();
  }

  try {
    let membrosGrupo = null;
    if (groupId) {
      const resGrupo = await callGenesys(`/api/v2/teams/${groupId}/members?pageSize=100`);
      if (resGrupo.entities) membrosGrupo = resGrupo.entities.map(m => m.id);
    }

    const dicPresencas = {};
    const resPres = await callGenesys('/api/v2/presencedefinitions?pageSize=100');
    if (resPres.entities) resPres.entities.forEach(p => { dicPresencas[p.id] = (p.languageLabels && (p.languageLabels["pt-BR"] || p.languageLabels["pt_BR"])) || p.name; });

    const traducoesPadrao = { "Available": "Disponível", "Break": "Pausa Básica", "Meal": "Pausa Refeição", "Meeting": "Reunião", "Training": "Treinamento", "Away": "Ausente do PC", "Busy": "Ocupado" };

    let agentes = [];
    let paginaAtual = 1;
    let temMaisDados = true;
    let interagindoAgoraGlobal = 0;

    while (temMaisDados) {
      const rUsers = await callGenesys(`/api/v2/routing/queues/${queueId}/members?expand=presence&expand=routingStatus&expand=conversationSummary&pageSize=100&pageNumber=${paginaAtual}`);
      if (rUsers.erro || !rUsers.entities) break;

      rUsers.entities.forEach(member => {
        let uObj = member.user || member;
        let userId = uObj.id || member.id;
        if (membrosGrupo && membrosGrupo.indexOf(userId) === -1) return;

        let rStatus = (member.routingStatus || uObj.routingStatus || {}).status || "UNKNOWN";
        let presenceDef = (member.presence || uObj.presence || {}).presenceDefinition || {};
        let sysPresence = presenceDef.systemPresence || "Offline";
        let modifiedDate = (member.presence || uObj.presence || {}).modifiedDate || new Date().toISOString();

        let convSummary = member.conversationSummary || uObj.conversationSummary || null;
        let qtdInteracoes = 0;
        if (convSummary) {
          ['call', 'callback', 'chat', 'email', 'message', 'socialExpression', 'video'].forEach(c => {
            if (convSummary[c]) {
              if (typeof convSummary[c].contactCenter === 'object' && convSummary[c].contactCenter.active) qtdInteracoes += convSummary[c].contactCenter.active;
            }
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
            if (statusSecundario) { statusAmigavel = traducoesPadrao[statusSecundario] || statusSecundario; }
            else { statusAmigavel = traducoesPadrao[sysPresence] || sysPresence; }
            if (sysPresence === "Available" || sysPresence === "Interacting") {
               if (sysPresence === "Interacting") statusAmigavel = "Fora da Fila / Pessoal";
               tipoClass = "acw";
            } else { tipoClass = "break"; }
          }
        }

        agentes.push({
          id: userId, status: statusAmigavel, sysClass: tipoClass,
          pausaMs: Date.now() - new Date(modifiedDate).getTime(), interagindo: qtdInteracoes
        });
      });

      if (!rUsers.nextUri) temMaisDados = false; else paginaAtual++;
    }

    let esperandoAgora = 0;
    const payloadObsFila = { "filter": { "type": "and", "predicates": [ { "type": "dimension", "dimension": "queueId", "value": queueId } ] }, "metrics": ["oWaiting"] };
    const rObsFila = await callGenesys('/api/v2/analytics/queues/observations/query', 'post', payloadObsFila);
    if (rObsFila.results && rObsFila.results[0] && rObsFila.results[0].data) {
      rObsFila.results[0].data.forEach(d => { if(d.metric === 'oWaiting') esperandoAgora = d.stats.count || 0; });
    }

    return res.status(200).json({
      agentesStatus: agentes,
      filaEspera: esperandoAgora,
      ativasAgora: interagindoAgoraGlobal,
      timestamp: new Date().toLocaleTimeString('pt-BR')
    });

  } catch (e) {
    return res.status(500).json({ erro: String(e) });
  }
}
