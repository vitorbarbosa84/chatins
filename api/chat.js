// api/chat.js - Vercel API Function

export default async function handler(req, res) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message, userId, threadId } = req.body;
    
    console.log('Received message:', message);
    console.log('Received threadId:', threadId);
    
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const ASSISTANT_ID = 'asst_Gh8RwDmieO4Rykegs7V1fzbe';

    if (!OPENAI_API_KEY) {
      console.error('OpenAI API key not found');
      return res.status(500).json({ 
        success: false, 
        error: 'API key not configured' 
      });
    }

    console.log('API key found');

    // Use provided thread ID or create new one
    let currentThreadId = threadId;
    if (!currentThreadId) {
      console.log('Creating new thread...');
      
      const threadResponse = await fetch('https://api.openai.com/v1/threads', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        }
      });

      if (!threadResponse.ok) {
        const errorText = await threadResponse.text();
        console.error('Thread creation failed:', errorText);
        throw new Error(`Thread creation failed: ${threadResponse.status} - ${errorText}`);
      }

      const thread = await threadResponse.json();
      currentThreadId = thread.id;
      console.log('New thread created:', currentThreadId);
    } else {
      console.log('Using existing thread:', currentThreadId);
    }

    // Add message to thread
    console.log('Adding message to thread...');
    const messageResponse = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({
        role: 'user',
        content: message
      })
    });

    if (!messageResponse.ok) {
      const errorText = await messageResponse.text();
      console.error('Message creation failed:', errorText);
      throw new Error(`Message creation failed: ${messageResponse.status} - ${errorText}`);
    }

    // Run the assistant
    console.log('Running assistant...');
    const runResponse = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/runs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({
        assistant_id: ASSISTANT_ID
      })
    });

    if (!runResponse.ok) {
      const errorText = await runResponse.text();
      console.error('Run creation failed:', errorText);
      throw new Error(`Run creation failed: ${runResponse.status} - ${errorText}`);
    }

    const run = await runResponse.json();
    console.log('Run started:', run.id);

    // Wait for completion with timeout
    let runStatus = run;
    let attempts = 0;
    const maxAttempts = 30; // Vercel has longer timeout (10s default)
    
    while ((runStatus.status === 'queued' || runStatus.status === 'in_progress') && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const statusResponse = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/runs/${run.id}`, {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2'
        }
      });

      if (!statusResponse.ok) {
        const errorText = await statusResponse.text();
        console.error('Status check failed:', errorText);
        throw new Error(`Status check failed: ${statusResponse.status} - ${errorText}`);
      }

      runStatus = await statusResponse.json();
      attempts++;
      console.log(`Attempt ${attempts}: Status is ${runStatus.status}`);
    }

    if (runStatus.status === 'completed') {
      console.log('Run completed, fetching messages...');
      
      // Get messages
      const messagesResponse = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/messages`, {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2'
        }
      });

      if (!messagesResponse.ok) {
        const errorText = await messagesResponse.text();
        console.error('Messages fetch failed:', errorText);
        throw new Error(`Messages fetch failed: ${messagesResponse.status} - ${errorText}`);
      }

      const messages = await messagesResponse.json();
      const assistantMessage = messages.data[0];
      
      console.log('Success! Returning response');
      return res.status(200).json({
        success: true,
        response: assistantMessage.content[0].text.value,
        threadId: currentThreadId
      });
    } else {
      console.error('Run did not complete:', runStatus.status);
      return res.status(500).json({
        success: false,
        error: `Assistant run status: ${runStatus.status}. Try again.`
      });
    }

  } catch (error) {
    console.error('Function error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
}
