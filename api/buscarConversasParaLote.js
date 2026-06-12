export default async function handler(req, res) {
  // Configuração de Headers CORS para evitar bloqueios em requisições massivas
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido' });
  }

  const { token, baseUrl, queueId, wrapupId, intervaloIso, limite } = req.body;

  if (!token) return res.status(200).json({ erro: 'Token Genesys Cloud ausente.' });
  if (!queueId || !intervaloIso) return res.status(200).json({ erro: 'Parâmetros de busca incompletos.' });

  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');
  
  // Monta os filtros exatamente no padrão que o Analytics do Genesys exige
  const predicates = [
    { "dimension": "queueId", "value": queueId }
  ];
  
  // Se o usuário escolheu uma finalização específica, adiciona ao filtro
  if (wrapupId) {
    predicates.push({ "dimension": "wrapUpCode", "value": wrapupId });
  }

  const payload = {
    "interval": intervaloIso,
    "segmentFilters": [{ "type": "and", "predicates": predicates }],
    "paging": { "pageSize": parseInt(limite) || 10, "pageNumber": 1 }
  };

  try {
    // CORREÇÃO CRÍTICA: Explicitando o método POST e incluindo o Body corretamente
    const response = await fetch(`${cleanUrl}/api/v2/analytics/conversations/details/query`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    
    if (!response.ok) {
      return res.status(200).json({ erro: data.message || `Erro Genesys HTTP ${response.status}` });
    }
    
    const convs = data.conversations || [];
    
    // Devolve os IDs encontrados de forma segura
    return res.status(200).json({ 
      ok: true, 
      ids: convs.map(c => c.conversationId) 
    });

  } catch (e) {
    // Captura qualquer falha de rede e evita o Erro 500 na Vercel
    return res.status(200).json({ erro: 'Falha interna ao buscar lote: ' + e.message });
  }
}
