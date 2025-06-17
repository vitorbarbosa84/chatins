// api/chat.js - Converted from PHP to JavaScript for Vercel

export default async function handler(req, res) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ 
      success: false, 
      error: 'Method not allowed. Please use POST.' 
    });
  }

  try {
    // Get request data
    const { message, userId, threadId, assessmentData } = req.body;
    
    console.log('Received request:', {
      message: message?.substring(0, 100) + '...',
      userId,
      threadId,
      hasAssessmentData: !!assessmentData
    });
    
    // Get environment variables
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const GOOGLE_SHEETS_API_KEY = process.env.GOOGLE_SHEETS_API_KEY;
    const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
    const ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || 'asst_Gh8RwDmieO4Rykegs7V1fzbe';

    // Validate required environment variables
    if (!OPENAI_API_KEY) {
      console.error('OPENAI_API_KEY not found in environment variables');
      return res.status(500).json({ 
        success: false, 
        error: 'Server configuration error: Missing OpenAI API key' 
      });
    }

    // Validate required request data
    if (!message && !assessmentData?.requestQuote) {
      return res.status(400).json({
        success: false,
        error: 'Message is required'
      });
    }

    // Check if this is a quote request
    if (assessmentData && assessmentData.requestQuote) {
      console.log('Processing insurance quote request...');
      
      // Validate required assessment data
      if (!assessmentData.companyName || !assessmentData.industry) {
        return res.status(400).json({
          success: false,
          error: 'Company name and industry are required for quote generation'
        });
      }

      try {
        // Process quote using Google Sheets
        if (GOOGLE_SHEETS_API_KEY && SPREADSHEET_ID) {
          const quote = await processInsuranceQuoteWithSheets(
            assessmentData, 
            GOOGLE_SHEETS_API_KEY, 
            SPREADSHEET_ID
          );
          
          return res.status(200).json({
            success: true,
            response: formatQuoteResponse(quote),
            threadId: threadId,
            quote: quote,
            type: 'quote'
          });
        } else {
          // Fallback to local calculation if Google Sheets not configured
          const quote = calculateQuoteLocally(assessmentData);
          
          return res.status(200).json({
            success: true,
            response: formatQuoteResponse(quote),
            threadId: threadId,
            quote: quote,
            type: 'quote'
          });
        }
        
      } catch (error) {
        console.error('Quote processing error:', error);
        return res.status(500).json({
          success: false,
          error: 'Failed to process insurance quote. Please check your information and try again.'
        });
      }
    }

    // Regular chat processing with OpenAI Assistant
    console.log('Processing regular chat message...');

    // Get or create thread
    let currentThreadId = threadId;
    if (!currentThreadId) {
      console.log('Creating new OpenAI thread...');
      
      try {
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
          throw new Error(`Failed to create thread: ${threadResponse.status}`);
        }

        const thread = await threadResponse.json();
        currentThreadId = thread.id;
        console.log('New thread created:', currentThreadId);
      } catch (error) {
        console.error('Thread creation error:', error);
        return res.status(500).json({
          success: false,
          error: 'Failed to initialize conversation. Please try again.'
        });
      }
    } else {
      console.log('Using existing thread:', currentThreadId);
    }

    // Add message to thread
    console.log('Adding message to thread...');
    try {
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
        throw new Error(`Failed to add message: ${messageResponse.status}`);
      }
    } catch (error) {
      console.error('Message creation error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to process your message. Please try again.'
      });
    }

    // Run the assistant
    console.log('Running OpenAI assistant...');
    let runId;
    try {
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
        throw new Error(`Failed to start assistant: ${runResponse.status}`);
      }

      const run = await runResponse.json();
      runId = run.id;
      console.log('Assistant run started:', runId);
    } catch (error) {
      console.error('Run creation error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to start AI assistant. Please try again.'
      });
    }

    // Wait for completion with timeout
    console.log('Waiting for assistant response...');
    let runStatus;
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds timeout
    
    try {
      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
        
        const statusResponse = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/runs/${runId}`, {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          }
        });

        if (!statusResponse.ok) {
          const errorText = await statusResponse.text();
          console.error('Status check failed:', errorText);
          throw new Error(`Failed to check status: ${statusResponse.status}`);
        }

        runStatus = await statusResponse.json();
        attempts++;
        
        console.log(`Attempt ${attempts}: Status is ${runStatus.status}`);
        
        if (runStatus.status === 'completed') {
          break;
        } else if (runStatus.status === 'failed' || runStatus.status === 'cancelled') {
          throw new Error(`Assistant run ${runStatus.status}: ${runStatus.last_error?.message || 'Unknown error'}`);
        } else if (runStatus.status !== 'queued' && runStatus.status !== 'in_progress') {
          console.log('Unexpected status:', runStatus.status);
        }
      }
    } catch (error) {
      console.error('Run monitoring error:', error);
      return res.status(500).json({
        success: false,
        error: 'Assistant processing failed. Please try again.'
      });
    }

    // Check if completed successfully
    if (!runStatus || runStatus.status !== 'completed') {
      console.error('Assistant did not complete in time. Status:', runStatus?.status);
      return res.status(408).json({
        success: false,
        error: 'Assistant response timed out. Please try again with a shorter message.'
      });
    }

    // Get the assistant's response
    console.log('Fetching assistant response...');
    try {
      const messagesResponse = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/messages`, {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2'
        }
      });

      if (!messagesResponse.ok) {
        const errorText = await messagesResponse.text();
        console.error('Messages fetch failed:', errorText);
        throw new Error(`Failed to get response: ${messagesResponse.status}`);
      }

      const messages = await messagesResponse.json();
      
      if (!messages.data || messages.data.length === 0) {
        throw new Error('No messages returned from assistant');
      }

      const assistantMessage = messages.data[0];
      
      if (!assistantMessage.content || assistantMessage.content.length === 0) {
        throw new Error('Empty response from assistant');
      }

      const responseText = assistantMessage.content[0]?.text?.value || 'I apologize, but I encountered an issue generating a response.';
      
      console.log('Successfully got assistant response');
      return res.status(200).json({
        success: true,
        response: responseText,
        threadId: currentThreadId,
        type: 'chat'
      });

    } catch (error) {
      console.error('Response retrieval error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve assistant response. Please try again.'
      });
    }

  } catch (error) {
    console.error('Unexpected error in chat handler:', error);
    return res.status(500).json({
      success: false,
      error: 'An unexpected error occurred. Please try again.'
    });
  }
}

// Function to process insurance quote using Google Sheets
async function processInsuranceQuoteWithSheets(assessmentData, apiKey, spreadsheetId) {
  console.log('Processing quote with Google Sheets...');
  
  try {
    // Prepare data for Google Sheets
    const timestamp = new Date().toISOString();
    const sheetData = [
      ['Timestamp', timestamp],
      ['Company Name', assessmentData.companyName || ''],
      ['Industry', assessmentData.industry || ''],
      ['Employee Count', assessmentData.employeeCount || ''],
      ['Annual Revenue', assessmentData.annualRevenue || ''],
      ['User ID', assessmentData.userId || ''],
      ['Thread ID', assessmentData.threadId || ''],
      
      // Category scores with defaults
      ['MFA Score', assessmentData.scores?.mfa || 1],
      ['Backup Score', assessmentData.scores?.backup || 1],
      ['Vulnerability Mgmt Score', assessmentData.scores?.vulnerability || 1],
      ['Incident Response Score', assessmentData.scores?.incident || 1],
      ['Employee Training Score', assessmentData.scores?.training || 1],
      ['Network Security Score', assessmentData.scores?.network || 1],
      ['Data Protection Score', assessmentData.scores?.dataProtection || 1],
      ['Endpoint Protection Score', assessmentData.scores?.endpoint || 1],
      ['Security Monitoring Score', assessmentData.scores?.monitoring || 1],
      ['Physical Security Score', assessmentData.scores?.physical || 1],
      ['Vendor Risk Score', assessmentData.scores?.vendor || 1],
      ['Business Continuity Score', assessmentData.scores?.continuity || 1],
      ['Compliance Score', assessmentData.scores?.compliance || 1],
      ['Identity Mgmt Score', assessmentData.scores?.identity || 1],
      ['Payment Security Score', assessmentData.scores?.payment || 1],
      ['Healthcare Data Score', assessmentData.scores?.healthcare || 1],
      ['Security Testing Score', assessmentData.scores?.testing || 1],
      ['Insurance History Score', assessmentData.scores?.history || 1]
    ];

    // Write to Google Sheets (append to Assessments sheet)
    const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Assessments!A:B:append?valueInputOption=RAW&key=${apiKey}`;
    
    const writeResponse = await fetch(writeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        values: sheetData
      })
    });

    if (!writeResponse.ok) {
      const errorText = await writeResponse.text();
      console.error('Google Sheets write failed:', errorText);
      throw new Error('Failed to write assessment data to Google Sheets');
    }

    console.log('Data written to Google Sheets successfully');

    // Small delay to allow Google Sheets to calculate
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Read calculated results from Google Sheets
    const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Calculations!A35:B60?key=${apiKey}`;
    
    const readResponse = await fetch(readUrl);
    if (!readResponse.ok) {
      const errorText = await readResponse.text();
      console.error('Google Sheets read failed:', errorText);
      throw new Error('Failed to read calculations from Google Sheets');
    }

    const sheetResults = await readResponse.json();
    const values = sheetResults.values || [];
    
    console.log('Retrieved calculation results from Google Sheets');
    
    // Parse the calculated quote from the sheets
    const quote = parseQuoteFromSheets(values, assessmentData);
    
    return quote;

  } catch (error) {
    console.error('Google Sheets processing error:', error);
    throw error;
  }
}

// Function to parse quote results from Google Sheets
function parseQuoteFromSheets(sheetValues, assessmentData) {
  try {
    // Create a lookup object from the sheet values
    const dataLookup = {};
    sheetValues.forEach(row => {
      if (row.length >= 2) {
        dataLookup[row[0]] = row[1];
      }
    });

    // Extract calculated values (adjust based on your sheet structure)
    const riskScore = parseFloat(dataLookup['Final Risk Score']) || 2.5;
    const riskLevel = dataLookup['Risk Level'] || 'Medium';
    const recommendedCoverage = parseFloat(dataLookup['Recommended Coverage']) || 1000000;
    const finalPremium = parseFloat(dataLookup['Final Premium']) || 5000;
    const deductible = parseFloat(dataLookup['Recommended Deductible']) || 10000;
    const basePremium = parseFloat(dataLookup['Base Premium']) || 4000;
    
    return {
      riskScore: riskScore,
      riskLevel: riskLevel,
      recommendedCoverage: recommendedCoverage,
      annualPremium: Math.round(finalPremium),
      monthlyPremium: Math.round(finalPremium / 12),
      deductible: deductible,
      basePremium: Math.round(basePremium),
      companyName: assessmentData.companyName,
      industry: assessmentData.industry,
      employeeCount: assessmentData.employeeCount,
      quoteValid: 30, // days
      timestamp: new Date().toISOString(),
      quoteId: `CYB-${Date.now()}`
    };
  } catch (error) {
    console.error('Error parsing quote from sheets:', error);
    throw new Error('Failed to parse calculation results from Google Sheets');
  }
}

// Fallback function for local quote calculation
function calculateQuoteLocally(assessmentData) {
  console.log('Using local quote calculation fallback...');
  
  // Industry base rates (per $1M coverage)
  const industryRates = {
    'Healthcare': 1200,
    'Financial Services': 1100,
    'Technology': 800,
    'Education': 900,
    'Manufacturing': 700,
    'Retail': 750,
    'Professional Services': 650,
    'Government': 1000,
    'Other': 750
  };

  // Size modifiers
  const sizeModifiers = {
    '1-10': 0.9,
    '11-50': 0.95,
    '51-250': 1.0,
    '251-1000': 1.05,
    '1000+': 1.1
  };

  // Calculate weighted risk score
  const scores = assessmentData.scores || {};
  const weights = {
    mfa: 0.15, backup: 0.12, vulnerability: 0.10, incident: 0.10, training: 0.08
  };
  
  let riskScore = 0;
  Object.keys(weights).forEach(category => {
    riskScore += (scores[category] || 1) * weights[category];
  });
  
  // Add remaining categories with equal weight
  const remainingWeight = 1 - Object.values(weights).reduce((a, b) => a + b, 0);
  const remainingCategories = 13; // Total 18 - 5 major categories
  const categoryWeight = remainingWeight / remainingCategories;
  
  riskScore += categoryWeight * remainingCategories * 2; // Assume average score of 2
  
  // Apply modifiers
  const baseRate = industryRates[assessmentData.industry] || industryRates['Other'];
  const sizeModifier = sizeModifiers[assessmentData.employeeCount] || 1.0;
  
  // Determine coverage and premium
  const recommendedCoverage = getRecommendedCoverage(assessmentData.annualRevenue);
  const basePremium = (recommendedCoverage / 1000000) * baseRate;
  
  // Risk multiplier
  let riskMultiplier = 1.0;
  if (riskScore >= 3.5) riskMultiplier = 0.85; // Low risk discount
  else if (riskScore < 2.5) riskMultiplier = 1.25; // High risk penalty
  
  const finalPremium = Math.round(basePremium * riskMultiplier * sizeModifier);
  
  return {
    riskScore: Math.round(riskScore * 100) / 100,
    riskLevel: riskScore >= 3.5 ? 'Low' : riskScore >= 2.5 ? 'Medium' : 'High',
    recommendedCoverage: recommendedCoverage,
    annualPremium: finalPremium,
    monthlyPremium: Math.round(finalPremium / 12),
    deductible: getRecommendedDeductible(recommendedCoverage),
    basePremium: Math.round(basePremium),
    companyName: assessmentData.companyName,
    industry: assessmentData.industry,
    employeeCount: assessmentData.employeeCount,
    quoteValid: 30,
    timestamp: new Date().toISOString(),
    quoteId: `CYB-${Date.now()}`
  };
}

// Helper function to get recommended coverage
function getRecommendedCoverage(revenueRange) {
  const coverageMap = {
    '<$1M': 1000000,
    '$1M-$10M': 5000000,
    '$10M-$100M': 25000000,
    '$100M+': 50000000
  };
  return coverageMap[revenueRange] || 1000000;
}

// Helper function to get recommended deductible
function getRecommendedDeductible(coverage) {
  if (coverage <= 5000000) return 10000;
  if (coverage <= 15000000) return 25000;
  return 50000;
}

// Function to format the quote response for the user
function formatQuoteResponse(quote) {
  return `🔒 **CYBERSECURITY INSURANCE QUOTE**

**Company**: ${quote.companyName}
**Industry**: ${quote.industry} | **Employees**: ${quote.employeeCount}
**Risk Assessment**: ${quote.riskLevel} Risk (Score: ${quote.riskScore}/4.0)

💰 **RECOMMENDED COVERAGE**
• **Coverage Limit**: $${quote.recommendedCoverage.toLocaleString()}
• **Annual Premium**: $${quote.annualPremium.toLocaleString()}
• **Monthly Premium**: $${quote.monthlyPremium.toLocaleString()}
• **Deductible**: $${quote.deductible.toLocaleString()}

📋 **COVERAGE INCLUDES**
✅ Data breach response & notification costs
✅ Cyber extortion & ransomware coverage
✅ Business interruption from cyber events
✅ Network security & privacy liability
✅ Regulatory fines & penalties
✅ Crisis management & PR services
✅ Forensic investigation costs
✅ Legal defense & settlements

💡 **YOUR RISK PROFILE**
${quote.riskLevel === 'Low' ? '🟢 **Excellent Security** - Your strong cybersecurity controls qualify you for preferred pricing!' :
  quote.riskLevel === 'Medium' ? '🟡 **Good Foundation** - Solid security with room for improvement to reduce premiums.' :
  '🔴 **Needs Attention** - Significant security gaps identified. Improvements could reduce your premium significantly.'}

⏰ **Quote Details**
• Quote ID: ${quote.quoteId}
• Valid until: ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString()}
• Generated: ${new Date(quote.timestamp).toLocaleDateString()}

**Next Steps**: Contact us to finalize your policy or ask about ways to improve your security posture for better rates!`;
}
