export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const { token, baseUrl, queueId, groupId, userId, intervaloIso, toleranciaMinutos } = req.body;
  if (!token || !queueId || !intervaloIso) {
    return res.status(200).json({ erro: 'Fila e Período são obrigatórios.' });
  }

  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');
  const limiteToleranciaMs = (parseInt(toleranciaMinutos) || 15) * 60000;

  try {
    // 1. Dicionário de Presenças da Organização para traduzir IDs em nomes reais
    const dicPresencas = {};
    const resPres = await fetch(`${cleanUrl}/api/v2/presencedefinitions?pageSize=100`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    if (resPres.ok) {
      const dataPres = await resPres.json();
      if (dataPres.entities) {
        dataPres.entities.forEach(p => {
          dicPresencas[p.id] = (p.languageLabels && (p.languageLabels["pt-BR"] || p.languageLabels["pt_BR"])) || p.name;
        });
      }
    }
    const traducoesPadrao = { "ON_QUEUE": "Fila", "AVAILABLE": "Disponível", "AWAY": "Ausente", "BREAK": "Pausa Básica", "MEAL": "Pausa Refeição", "MEETING": "Reunião", "TRAINING": "Treinamento", "BUSY": "Ocupado" };

    // 2. Determinar a lista de usuários alvos a serem pesquisados
    let listaUsuariosAlvo = [];
    if (userId) {
      listaUsuariosAlvo.push(userId);
    } else if (groupId) {
      const resGrupo = await fetch(`${cleanUrl}/api/v2/teams/${groupId}/members?pageSize=100`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      if (resGrupo.ok) {
        const dGrupo = await resGrupo.json();
        if (dGrupo.entities) listaUsuariosAlvo = dGrupo.entities.map(m => m.id);
      }
    } else {
      // Se não especificou operador nem equipe, busca todos os membros vinculados à fila
      const resFila = await fetch(`${cleanUrl}/api/v2/routing/queues/${queueId}/members?pageSize=100`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      if (resFila.ok) {
        const dFila = await resFila.json();
        if (dFila.entities) listaUsuariosAlvo = dFila.entities.map(m => m.id || m.user.id);
      }
    }

    if (listaUsuariosAlvo.length === 0) {
      return res.status(200).json({ ok: true, excedidos: [] });
    }

    // 3. Query de Analytics para extrair a Linha do Tempo (Timeline) detalhada das pausas
    const payloadWfm = {
      "interval": intervaloIso,
      "userFilters": [{ "type": "or", "predicates": listaUsuariosAlvo.map(id => ({ "dimension": "userId", "value": id })) }]
    };

    const resQuery = await fetch(`${cleanUrl}/api/v2/analytics/users/details/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadWfm)
    });

    const dataQuery = await resQuery.json();
    if (!resQuery.ok) return res.status(200).json({ erro: dataQuery.message || 'Erro ao extrair dados WFM' });

    let relatorioFinal = [];

    // Map para obter dados cadastrais básicos (Nomes) dos agentes analisados
    const cacheNomes = {};
    if (dataQuery.userDetails) {
      // Pré-popula nomes baseados no retorno para evitar chamadas um por um
      for (const u of dataQuery.userDetails) {
        try {
          const resUserObj = await fetch(`${cleanUrl}/api/v2/users/${u.userId}`, { headers: { 'Authorization': `Bearer ${token}` } });
          if (resUserObj.ok) {
            const duObj = await resUserObj.json();
            cacheNomes[u.userId] = duObj.name;
          }
        } catch { cacheNomes[u.userId] = "Operador ID " + u.userId.substring(0,8); }
      }

      // 4. Varre os estados de presença e constrói o histórico de estouros
      dataQuery.userDetails.forEach(u => {
        let nomeAgente = cacheNomes[u.userId] || "Operador Desconhecido";
        let historicoPausasAgente = [];

        if (u.primaryPresence) {
          u.primaryPresence.forEach(pres => {
            let pDefId = pres.presenceDefinitionId;
            let nomeStatus = dicPresencas[pDefId] || traducoesPadrao[pres.systemPresence] || pres.systemPresence;
            
            // Ignora se for status de trabalho (Disponível, Em Fila) ou se não tiver fim calculado ainda (se for retroativo)
            if (pres.systemPresence !== "AVAILABLE" && pres.systemPresence !== "OFFLINE" && pres.systemPresence !== "ON_QUEUE") {
              let inicio = new Date(pres.startTime);
              let fim = pres.endTime ? new Date(pres.endTime) : new Date(); // Se não tem fim, assume o momento atual
              let duracaoMs = fim.getTime() - inicio.getTime();

              if (duracaoMs > 0) {
                let estouroMs = duracaoMs - limiteToleranciaMs;
                let hLocalInicio = inicio.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                let hLocalFim = pres.endTime ? fim.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : "Ainda em Pausa";

                historicoPausasAgente.push({
                  status: nomeStatus,
                  inicio: hLocalInicio,
                  fim: hLocalFim,
                  tempoTotalMin: Math.floor(duracaoMs / 60000),
                  estourou: estouroMs > 0,
                  tempoEstouroMin: estouroMs > 0 ? Math.floor(estouroMs / 60000) : 0
                });
              }
            }
          });
        }

        // Filtra para o relatório o agente que teve qualquer registro de pausas no período solicitado
        if (historicoPausasAgente.length > 0) {
          relatorioFinal.push({
            userId: u.userId,
            nome: nomeAgente,
            pausas: historicoPausasAgente,
            totalEstourosNoPeriodo: historicoPausasAgente.filter(p => p.estourou).length
          });
        }
      });
    }

    // Ordena colocando quem teve mais ocorrências de estouros WFM no topo
    relatorioFinal.sort((a, b) => b.totalEstourosNoPeriodo - a.totalEstourosNoPeriodo);

    return res.status(200).json({ ok: true, dados: relatorioFinal });

  } catch (e) {
    return res.status(200).json({ erro: 'Erro WFM: ' + e.message });
  }
}
