export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const { token, baseUrl, queueId, groupId, userId, intervaloIso } = req.body;
  if (!token || !queueId || !intervaloIso) {
    return res.status(200).json({ erro: 'Fila e Período de análise são obrigatórios.' });
  }

  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');

  // CONFIGURAÇÃO REGRAS WFM DA BRISANET
  const TOLERANCIA_GERAL_MS = 2 * 60000; // 2 minutos de tolerância fixa

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
    
    // Mapeamento de termos comuns vindos do Genesys para as chaves internas
    const traducoesPadrao = { 
      "ON_QUEUE": "Fila", "AVAILABLE": "Disponível", "AWAY": "Ausente", 
      "BREAK": "Pausa Auricular", "MEAL": "Refeição", "MEETING": "Reunião", 
      "TRAINING": "Treinamento", "BUSY": "Ocupado" 
    };

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
      const resFila = await fetch(`${cleanUrl}/api/v2/routing/queues/${queueId}/members?pageSize=100`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      if (resFila.ok) {
        const dFila = await resFila.json();
        if (dFila.entities) listaUsuariosAlvo = dFila.entities.map(m => m.id || m.user.id);
      }
    }

    if (listaUsuariosAlvo.length === 0) {
      return res.status(200).json({ ok: true, dados: [] });
    }

    // 3. Query de Analytics para extrair Timeline de Presença
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

    // Map para obter nomes dos agentes analisados
    const cacheNomes = {};
    if (dataQuery.userDetails) {
      for (const u of dataQuery.userDetails) {
        try {
          const resUserObj = await fetch(`${cleanUrl}/api/v2/users/${u.userId}`, { headers: { 'Authorization': `Bearer ${token}` } });
          if (resUserObj.ok) {
            const duObj = await resUserObj.json();
            cacheNomes[u.userId] = duObj.name;
          }
        } catch { cacheNomes[u.userId] = "Operador ID " + u.userId.substring(0,8); }
      }

      // 4. Varre a linha do tempo calculando os limites específicos
      dataQuery.userDetails.forEach(u => {
        let nomeAgente = cacheNomes[u.userId] || "Operador Desconhecido";
        let historicoPausasAgente = [];
        let totalEstourosAgente = 0;

        if (u.primaryPresence) {
          u.primaryPresence.forEach(pres => {
            let pDefId = pres.presenceDefinitionId;
            let nomeStatus = dicPresencas[pDefId] || traducoesPadrao[pres.systemPresence] || pres.systemPresence;
            
            // Filtra estados de trabalho e offline para focar apenas nas pausas/afastamentos
            if (pres.systemPresence !== "AVAILABLE" && pres.systemPresence !== "OFFLINE" && pres.systemPresence !== "ON_QUEUE") {
              let inicio = new Date(pres.startTime);
              let fim = pres.endTime ? new Date(pres.endTime) : new Date();
              let duracaoMs = fim.getTime() - inicio.getTime();

              if (duracaoMs > 0) {
                let tempoTotalMin = Math.floor(duracaoMs / 60000);
                let estourou = false;
                let tempoEstouroMin = 0;
                let limitePausaEstipulado = "N/A";

                let sysUpper = pres.systemPresence.toUpperCase();
                let nomeUpper = nomeStatus.toUpperCase();

                // Aplicação das regras de negócio solicitadas para Pausa Auricular (Break) e Refeição (Meal)
                if (sysUpper === "BREAK" || nomeUpper.includes("AURICULAR") || nomeUpper.includes("PAUSA 10")) {
                  limitePausaEstipulado = 10;
                  let limiteComToleranciaMs = (10 * 60000) + TOLERANCIA_GERAL_MS; // 12 minutos
                  if (duracaoMs > limiteComToleranciaMs) {
                    estourou = true;
                    tempoEstouroMin = Math.floor((duracaoMs - (10 * 60000)) / 60000);
                    totalEstourosAgente++;
                  }
                } 
                else if (sysUpper === "MEAL" || nomeUpper.includes("REFEIÇÃO") || nomeUpper.includes("ALMOÇO") || nomeUpper.includes("LANCHE")) {
                  limitePausaEstipulado = 20;
                  let limiteComToleranciaMs = (20 * 60000) + TOLERANCIA_GERAL_MS; // 22 minutos
                  if (duracaoMs > limiteComToleranciaMs) {
                    estourou = true;
                    tempoEstouroMin = Math.floor((duracaoMs - (20 * 60000)) / 60000);
                    totalEstourosAgente++;
                  }
                }

                let hLocalInicio = inicio.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                let hLocalFim = pres.endTime ? fim.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : "Ainda em Pausa";

                historicoPausasAgente.push({
                  status: nomeStatus,
                  inicio: hLocalInicio,
                  fim: hLocalFim,
                  tempoTotalMin: tempoTotalMin,
                  toleranciaConfigurada: limitePausaEstipulado,
                  estourou: estourou,
                  tempoEstouroMin: tempoEstouroMin
                });
              }
            }
          });
        }

        // ALTERAÇÃO CRÍTICA: Sempre adiciona o agente no relatório final (mesmo se não tiver estouros),
        // desde que ele pertença à lista mapeada da equipe
        relatorioFinal.push({
          userId: u.userId,
          nome: nomeAgente,
          pausas: historicoPausasAgente, // Carrega o histórico completo de pausas realizadas no dia
          totalEstourosNoPeriodo: totalEstourosAgente
        });
      });
    }

    // Ordenação do relatório: Quem tiver mais estouros acumulados fica no topo para chamar atenção da supervisão
    relatorioFinal.sort((a, b) => b.totalEstourosNoPeriodo - a.totalEstourosNoPeriodo);

    return res.status(200).json({ ok: true, dados: relatorioFinal });

  } catch (e) {
    return res.status(200).json({ erro: 'Erro WFM Interno: ' + e.message });
  }
}
