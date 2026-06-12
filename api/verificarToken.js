export default async function handler(req, res) {
  // Aceita apenas requisições POST
  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido' });
  }

  const { token, baseUrl } = req.body;

  if (!token) {
    return res.status(400).json({ valido: false, message: 'Token ausente.' });
  }

  // Prepara a URL removendo a barra final se existir
  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim();
  if (cleanUrl.endsWith('/')) cleanUrl = cleanUrl.slice(0, -1);

  try {
    // Faz a chamada para a API do Genesys Cloud
    const response = await fetch(`${cleanUrl}/api/v2/users/me`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    if (response.status === 401) {
      return res.status(200).json({ valido: false, message: 'Token inválido ou expirado.' });
    }

    if (!response.ok) {
      return res.status(200).json({ valido: false, message: `Erro HTTP ${response.status}` });
    }

    // Retorna os dados do usuário se o token for válido
    return res.status(200).json({
      valido: true,
      nome: data.name || 'Usuário',
      email: data.email || '',
      divisao: data.division ? data.division.name : ''
    });

  } catch (error) {
    return res.status(500).json({ valido: false, message: 'Erro interno no servidor: ' + error.message });
  }
}
