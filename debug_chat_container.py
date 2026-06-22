from pathlib import Path
text = Path('agentview.html').read_text(encoding='utf-8')
print('chat-container', text.count('<div id="chat-container">'))
print('chat-area', text.count('<div id="chat-area">'))
print('bottom-panel', text.count('<div id="bottom-panel">'))
print('skills comment', text.count('<!-- ¼¼ÄÜµ¯´° -->'))
