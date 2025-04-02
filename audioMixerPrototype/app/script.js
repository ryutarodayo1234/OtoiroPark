document.addEventListener('DOMContentLoaded', () => {
    // --- グローバル変数・定数 ---
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const mixerElement = document.getElementById('mixer');
    const playPauseButton = document.getElementById('play-pause-button');
    const stopButton = document.getElementById('stop-button');
    const waveformCanvas = document.getElementById('waveform-canvas');
    let waveformCtx = null;
    const timeDisplay = document.getElementById('time-display');
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingProgress = document.getElementById('loading-progress');

    let globalAnalyserNode; // 全体ミックス用 (波形表示用)
    let analyserNodes = {}; // 各トラック用レベルメーター用 { [trackId]: AnalyserNode }
    let meterDataArrays = {}; // 各トラックのレベルデータ格納用 { [trackId]: Float32Array }

    let audioBuffers = {};
    let sourceNodes = {};
    let gainNodes = {};
    let muteNodes = {};
    let soloedTracks = new Set();
    let isPlaying = false;
    let isDraggingProgressBar = false;
    let startTime = 0;
    let pauseOffset = 0;
    let animationFrameId = null;
    let totalDuration = 0;

    let combinedWaveformData = null;
    let isGeneratingWaveform = false;

    // --- トラック情報 (色情報を追加) ---
    const tracks = [
        { id: 'strings', name: 'Strings', svgPath: 'icons/test.svg', path: 'audio/strings.mp3', color: '#a0522d' }, // シエナ
        { id: 'brass', name: 'Brass', svgPath: 'icons/test.svg', path: 'audio/brass.mp3', color: '#ffd700' },   // ゴールド
        { id: 'woodwinds', name: 'Woodwinds', svgPath: 'icons/test.svg', path: 'audio/woodwinds.mp3', color: '#228b22' }, // フォレストグリーン
        { id: 'untuned', name: 'Untuned Perc', svgPath: 'icons/test.svg', path: 'audio/unTunedPercssion.mp3', color: '#454545' }, // ライトスレートグレー
        { id: 'keyboards', name: 'Keyboards', svgPath: 'icons/test.svg', path: 'audio/keyboards.mp3', color: '#4682b4' }, // スチールブルー
        { id: 'fx', name: 'FX', svgPath: 'icons/test.svg', path: 'audio/fx.mp3', color: '#da70d6' },       // オーキッド
    ];

    // --- 初期化 ---
    async function init() {
        if (waveformCanvas) {
             waveformCtx = waveformCanvas.getContext('2d');
        } else {
             console.error("Waveform canvas element not found!");
        }

        showLoading();
        setupGlobalAnalyser();
        await createMixerUI();
        await loadAllAudioFiles();
        setupEventListeners();

        // スペースキーで再生・一時停止を切り替えるイベントリスナー
        document.addEventListener('keydown', (event) => {
            if (event.code === 'Space') {
                event.preventDefault(); // ページスクロールなどのデフォルト動作を防ぐ
                if (isPlaying) {
                    pauseAudio(); // 再生中なら一時停止
                } else {
                    playAudio(); // 停止中なら再生
                }
            }
        });

        // ★ 初期メーター色を設定 ★ (レベルは再生時に0になる)
        document.querySelectorAll('.track').forEach(trackElement => {
            const trackId = trackElement.dataset.trackId;
            const track = tracks.find(t => t.id === trackId);
            const meterBar = trackElement.querySelector('.level-bar');
            if (track && track.color && meterBar) {
                meterBar.style.setProperty('--meter-bar-color', track.color);
            }
            // フェーダーの初期値はHTMLで設定済み (value="1")
        });

        hideLoading();
        console.log("Audio Mixer Initialized");
        if (waveformCanvas) {
             resizeCanvas();
        }
    }

    // --- UI関連 ---
    function showLoading(loaded = 0, total = tracks.length) {
        if (!loadingOverlay || !loadingProgress) return;
        loadingOverlay.classList.remove('hidden');
        loadingProgress.max = total;
        loadingProgress.value = loaded;
        const loadingText = loadingOverlay.querySelector('p');
        if(loadingText) loadingText.textContent = `オーディオ読み込み中 (${loaded}/${total})...`;
    }

    function hideLoading() {
        if (!loadingOverlay) return;
        loadingOverlay.classList.add('hidden');
    }

    async function createMixerUI() {
        if (!mixerElement) return;
        mixerElement.innerHTML = ''; // まず中身を空にする
    
        for (const track of tracks) {
            const trackDiv = document.createElement('div');
            trackDiv.classList.add('track');
            trackDiv.dataset.trackId = track.id;
    
            let svgIconHTML = '<span class="icon-placeholder">?</span>';
            if (track.svgPath) {
                try {
                    const response = await fetch(track.svgPath);
                    if (!response.ok) throw new Error(`Failed to load SVG: ${response.statusText}`);
                    const svgText = await response.text();
                    const parser = new DOMParser();
                    const svgDoc = parser.parseFromString(svgText, "image/svg+xml");
                    const svgElement = svgDoc.querySelector('svg');
                    if (svgElement) {
                        svgElement.classList.add('track-icon');
                        svgIconHTML = svgElement.outerHTML;
                    } else {
                        console.warn(`Valid SVG not found in ${track.svgPath}`);
                    }
                } catch (error) {
                    console.error(`Error loading SVG for ${track.name}:`, error);
                }
            }
    
            // HTML構造を組み立てる
            trackDiv.innerHTML = `
                <div class="track-info">
                    ${svgIconHTML}
                    <span class="track-name">${track.name}</span>
                </div>
                <div class="track-controls">
                    <input type="range" class="fader" min="0" max="1.5" step="0.01" value="0.8" aria-label="${track.name} Volume">
                    <div class="level-meter" aria-hidden="true">
                        <div class="level-bar"></div>
                    </div>
                </div>
                <div class="buttons">
                    <button class="solo-button" aria-pressed="false" aria-label="${track.name} Solo">S</button>
                    <button class="mute-button" aria-pressed="false" aria-label="${track.name} Mute">M</button>
                </div>
                <button class="download-button" aria-pressed="false" data-track-id="${track.id}" aria-label="${track.name} Download"><i class="fas fa-download"></i></button>
            `;
    
            mixerElement.appendChild(trackDiv);
        }
    
        // ダウンロードボタンのイベントリスナーを設定
        mixerElement.querySelectorAll('.download-button').forEach(button => {
            button.addEventListener('click', (event) => {
                const trackId = button.dataset.trackId;
                const track = tracks.find(t => t.id === trackId);
                if (track) {
                    const wavFileName = track.path.replace('.mp3', '.wav'); // .mp3 を .wav に置き換え
                    downloadFile(wavFileName, `${track.name}.wav`);

                    // ボタンに "downloaded" クラスを追加して視覚的変化を適用
                    button.classList.remove('downloaded2');
                    button.classList.add('downloaded');
                    button.innerHTML = '<i class="fas fa-check"></i>'; // ボタンのテキストを変更
                }
            });

            // ホバー時にクラスを一時的に変更
            button.addEventListener('mouseenter', () => {
                if (button.classList.contains('downloaded')) {
                    button.innerHTML = '<i class="fas fa-download"></i>'; // 一時的にダウンロードアイコンに変更
                    button.classList.add('downloaded2');
                }
            });

            // ホバーが外れたときに元に戻す
            button.addEventListener('mouseleave', () => {
                if (button.classList.contains('downloaded')) {
                    button.innerHTML = '<i class="fas fa-check"></i>'; // 元の状態に戻す
                    button.classList.remove('downloaded2');
                }
            });
        });

        console.log("Mixer UI created.");
    }
    
    // ファイルをダウンロードする関数
    function downloadFile(filePath, fileName) {
        const link = document.createElement('a');
        link.href = filePath;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // --- オーディオ読み込み (変更なし) ---
    async function loadAudioFile(track) {
        try {
            const response = await fetch(track.path);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status} for ${track.path}`);
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            audioBuffers[track.id] = audioBuffer;
            if (audioBuffer.duration > totalDuration) {
                totalDuration = audioBuffer.duration;
            }
            console.log(`Loaded: ${track.name} (Duration: ${formatTime(audioBuffer.duration)})`);
        } catch (error) {
            console.error(`Error loading audio file ${track.path}:`, error);
            audioBuffers[track.id] = null;
        }
    }

    async function loadAllAudioFiles() {
        let loadedCount = 0;
        showLoading(loadedCount, tracks.length);
        const loadPromises = tracks.map(async (track) => {
            await loadAudioFile(track);
            loadedCount++;
            showLoading(loadedCount, tracks.length);
        });
        await Promise.all(loadPromises);
        updateTimeDisplay();

        if (waveformCanvas && waveformCtx) {
            await generateStaticWaveform(waveformCanvas.width);
        }
        console.log(`All audio files processed. Total duration: ${formatTime(totalDuration)}`);
    }

    // --- 静的波形データ生成 (変更なし) ---
    async function generateStaticWaveform(targetWidth) {
        if (isGeneratingWaveform || targetWidth <= 0 || !waveformCtx) return;
        isGeneratingWaveform = true;
        console.log(`Generating static waveform for width: ${targetWidth}...`);
        combinedWaveformData = null;
        requestAnimationFrame(drawWaveform);

        const validBuffers = Object.values(audioBuffers).filter(b => b instanceof AudioBuffer);
        if (validBuffers.length === 0 || totalDuration <= 0) {
            console.warn("No valid audio buffers or duration is zero. Cannot generate waveform.");
            isGeneratingWaveform = false;
            requestAnimationFrame(drawWaveform);
            return;
        }

        try {
            const sampleRate = audioContext.sampleRate;
            const totalSamples = Math.floor(totalDuration * sampleRate);
            if (totalSamples <= 0) {
                console.warn("Total samples calculated as zero or negative. Cannot generate waveform.");
                isGeneratingWaveform = false;
                requestAnimationFrame(drawWaveform);
                return;
            }

            const combinedData = new Float32Array(totalSamples).fill(0);
            let activeTracks = 0;
            for (const trackId in audioBuffers) {
                const buffer = audioBuffers[trackId];
                if (buffer instanceof AudioBuffer && buffer.numberOfChannels > 0) {
                    const channelData = buffer.getChannelData(0);
                    const lengthToProcess = Math.min(channelData.length, totalSamples);
                    for (let i = 0; i < lengthToProcess; i++) {
                        combinedData[i] += channelData[i];
                    }
                    activeTracks++;
                }
            }

            if (activeTracks > 0) {
                for (let i = 0; i < totalSamples; i++) {
                    combinedData[i] /= activeTracks;
                }
            } else {
                 console.warn("No active tracks with data found during waveform generation.");
                 isGeneratingWaveform = false;
                 requestAnimationFrame(drawWaveform);
                 return;
            }

            const samplesPerPixel = Math.max(1, Math.floor(totalSamples / targetWidth));
            const waveform = [];
            for (let i = 0; i < targetWidth; i++) {
                const start = Math.floor(i * samplesPerPixel);
                const end = Math.min(start + samplesPerPixel, totalSamples);
                if (start >= end) {
                    waveform.push({ min: 0, max: 0 });
                    continue;
                }
                let min = 1.0, max = -1.0;
                for (let j = start; j < end; j++) {
                    const sample = combinedData[j];
                    if (sample < min) min = sample;
                    if (sample > max) max = sample;
                }
                if (min === 1.0 && max === -1.0) {
                     min = 0; max = 0;
                }
                waveform.push({ min: min, max: max });
            }
            combinedWaveformData = waveform;
            console.log(`Generated static waveform data with ${waveform.length} points.`);
        } catch (error) {
            console.error("Error generating static waveform:", error);
            combinedWaveformData = null;
        } finally {
            isGeneratingWaveform = false;
            requestAnimationFrame(drawWaveform);
        }
    }

    // --- オーディオ再生・制御 ---

    // 各トラック用AnalyserNodeのセットアップ
    function setupTrackAnalyser(trackId) {
        try {
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.6;
            analyser.minDecibels = -90;
            analyser.maxDecibels = -10;
            analyserNodes[trackId] = analyser;
            const bufferLength = analyser.fftSize;
            meterDataArrays[trackId] = new Float32Array(bufferLength);
            console.log(`AnalyserNode setup for track: ${trackId}`);
        } catch(e) {
            console.error(`Failed to create AnalyserNode for track ${trackId}:`, e);
        }
    }

    // ノードの準備 (AnalyserNode接続を追加)
    function setupAudioNodes(trackId) {
        if (!audioBuffers[trackId]) {
            console.warn(`[setupAudioNodes] No audio buffer for ${trackId}`);
            return;
        }
        if (!analyserNodes[trackId]) {
            setupTrackAnalyser(trackId);
        }
        const trackAnalyser = analyserNodes[trackId];
    
        if (sourceNodes[trackId]) { try { sourceNodes[trackId].disconnect(); } catch(e){} }
        if (gainNodes[trackId]) { try { gainNodes[trackId].disconnect(); } catch(e){} }
        if (muteNodes[trackId]) { try { muteNodes[trackId].disconnect(); } catch(e){} }
    
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffers[trackId];
        const gainNode = audioContext.createGain();
        const muteNode = audioContext.createGain();
    
        try {
            source.connect(gainNode).connect(muteNode);
            if (trackAnalyser) {
                muteNode.connect(trackAnalyser); // レベルメーター用
                if (globalAnalyserNode) {
                    muteNode.connect(globalAnalyserNode); // 音もglobalAnalyserへ
                } else {
                    muteNode.connect(audioContext.destination);
                }
            } else if (globalAnalyserNode) {
                muteNode.connect(globalAnalyserNode);
            } else {
                muteNode.connect(audioContext.destination);
            }
        } catch (e) {
            console.error(`[setupAudioNodes] Error connecting nodes for ${trackId}:`, e);
            return;
        }
    
        sourceNodes[trackId] = source;
        gainNodes[trackId] = gainNode;
        muteNodes[trackId] = muteNode;
    
        const trackElement = mixerElement?.querySelector(`.track[data-track-id="${trackId}"]`);
        if (trackElement) {
            const fader = trackElement.querySelector(`.fader`);
            gainNode.gain.value = fader ? parseFloat(fader.value) : 1.0;
            const muteButton = trackElement.querySelector(`.mute-button`);
            muteNode.gain.value = (muteButton && muteButton.getAttribute('aria-pressed') === 'true') ? 0 : 1;
        } else {
            gainNode.gain.value = 1.0;
            muteNode.gain.value = 1.0;
        }
    
        // フェードインの初期設定 (-55dBからフェードイン)
        gainNode.gain.setValueAtTime(0.001, audioContext.currentTime); // -55dB ≈ 0.001
        gainNode.gain.exponentialRampToValueAtTime(1.0, audioContext.currentTime + 0.5); // 0.5秒でフェードイン
    
        source.onended = () => {
            console.log(`[onended] Node for track ${trackId} ended.`);
            if (sourceNodes[trackId] === source) {
                try { analyserNodes[trackId]?.disconnect(); } catch(e) {}
                delete analyserNodes[trackId];
                delete meterDataArrays[trackId];
                delete sourceNodes[trackId];
                delete gainNodes[trackId];
                delete muteNodes[trackId];
            }
            if (Object.keys(sourceNodes).length === 0 && !isDraggingProgressBar) {
                if (isPlaying) {
                    console.warn("[onended] All source nodes ended but isPlaying is still true. Forcing stop.");
                    stopAudio();
                } else {
                    console.log("[onended] All playback finished.");
                    if (playPauseButton) {
                        playPauseButton.innerHTML = '<i class="fas fa-play"></i>';
                        playPauseButton.setAttribute('aria-label', '再生');
                    }
                    updateTimeDisplay();
                    updateLevelMeters();
                    requestAnimationFrame(drawWaveform);
                }
            }
        };
    }
    
    // 再生を開始する関数 (変更なし)
    function playAudio() {
        if (audioContext.state === 'suspended') {
            audioContext.resume().then(() => {
                console.log("AudioContext resumed.");
                playAudioInternal();
            }).catch(err => console.error("Failed to resume AudioContext:", err));
        } else {
            playAudioInternal();
        }
    }

    // 内部的な再生開始処理 (変更なし)
    function playAudioInternal() {
        if (isPlaying || totalDuration <= 0) return;
        if (pauseOffset >= totalDuration) { pauseOffset = 0; }
        startTime = audioContext.currentTime - pauseOffset;
    
        // 必要なノードを再作成
        tracks.forEach(track => {
            if (audioBuffers[track.id]) {
                // 既存のノードを削除
                if (sourceNodes[track.id]) {
                    try {
                        sourceNodes[track.id].onended = null;
                        sourceNodes[track.id].disconnect();
                    } catch (e) {
                        console.warn(`[playAudioInternal] Error disconnecting source node for ${track.id}:`, e);
                    }
                    delete sourceNodes[track.id];
                }
                // 新しいノードを作成
                setupAudioNodes(track.id);
            }
        });
    
        let playbackWillStart = false;
        Object.keys(sourceNodes).forEach(trackId => {
            const source = sourceNodes[trackId];
            const buffer = audioBuffers[trackId];
            if (source && buffer) {
                try {
                    const duration = buffer.duration;
                    const offset = Math.max(0, Math.min(pauseOffset, duration));
                    if (offset < duration) {
                        source.start(0, offset); // 再生を開始
                        playbackWillStart = true;
                    }
                } catch (e) {
                    console.error(`[playAudioInternal] Error starting source node for ${trackId}:`, e);
                }
            }
        });
    
        if (!playbackWillStart && Object.keys(sourceNodes).length === 0) {
            console.log("[playAudioInternal] No tracks to play.");
            return;
        }
    
        updateSoloMuteState();
        isPlaying = true;
        if (playPauseButton) {
            playPauseButton.innerHTML = '<i class="fas fa-pause"></i>';
            playPauseButton.setAttribute('aria-label', '一時停止');
        }
        startAnimationLoop();
    }

    // 一時停止処理 (変更なし)
    function pauseAudio() {
        if (!isPlaying) return;
    
        const currentPlaybackTime = audioContext.currentTime - startTime;
        pauseOffset = Math.max(0, Math.min(currentPlaybackTime, totalDuration));
        console.log(`[pauseAudio] Pausing at offset: ${formatTime(pauseOffset)}`);
    
        Object.keys(sourceNodes).forEach(trackId => {
            const node = sourceNodes[trackId];
            const gainNode = gainNodes[trackId];
    
            if (node && gainNode) {
                try {
                    // フェードアウト処理 (0.5秒で-55dBまで)
                    gainNode.gain.setValueAtTime(gainNode.gain.value, audioContext.currentTime);
                    gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.5);
    
                    // 0.3秒後にノードを停止
                    setTimeout(() => {
                        node.onended = null;
                        node.stop(0);
                        node.disconnect();
                    }, 800);
                } catch (e) {
                    console.warn(`[pauseAudio] Error stopping source node for ${trackId}: ${e.message}`);
                }
            }
        });
    
        isPlaying = false;
        if (playPauseButton) {
            playPauseButton.innerHTML = '<i class="fas fa-play"></i>';
            playPauseButton.setAttribute('aria-label', '再生');
        }
    
        stopAnimationLoop();
        updateTimeDisplay();
        updateLevelMeters();
        requestAnimationFrame(drawWaveform);
    }

    // 完全停止処理 (フェードアウトを追加)
    function stopAudio() {
        console.log('[stopAudio] Stopping playback...');

        Object.keys(sourceNodes).forEach(trackId => {
            const node = sourceNodes[trackId];
            const gainNode = gainNodes[trackId];

            if (node && gainNode) {
                try {
                    // フェードアウト処理 (0.5秒で-55dBまで)
                    gainNode.gain.setValueAtTime(gainNode.gain.value, audioContext.currentTime);
                    gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.5);

                    // 0.5秒後にノードを停止
                    setTimeout(() => {
                        node.onended = null;
                        node.stop(0);
                        node.disconnect();
                    }, 800);
                } catch (e) {
                    console.warn(`[stopAudio] Error stopping source node for ${trackId}: ${e.message}`);
                }
            }
        });

        // ノードと状態をリセット
        analyserNodes = {};
        meterDataArrays = {};
        sourceNodes = {};
        gainNodes = {};
        muteNodes = {};
        pauseOffset = 0;
        startTime = 0;
        isPlaying = false;

        if (playPauseButton) {
            playPauseButton.innerHTML = '<i class="fas fa-play"></i>';
            playPauseButton.setAttribute('aria-label', '再生');
        }

        stopAnimationLoop();
        updateTimeDisplay();
        updateLevelMeters();
        requestAnimationFrame(drawWaveform);
        console.log("Playback stopped and reset.");
    }

    // シーク処理 (変更なし)
    function seekAudio(time) {
        if (totalDuration <= 0 || isNaN(time)) return;
        const seekTimeClamped = Math.max(0, Math.min(time, totalDuration));
        const wasPlaying = isPlaying;
        console.log(`[seekAudio] Seeking to: ${formatTime(seekTimeClamped)}, Was Playing: ${wasPlaying}`);
    
        // 再生中の場合のみノードを停止
        if (isPlaying) {
            Object.keys(sourceNodes).forEach(trackId => {
                const sourceNode = sourceNodes[trackId];
                if (sourceNode) {
                    try {
                        // ノードが再生されている場合のみ停止
                        sourceNode.onended = null;
                        sourceNode.stop(0);
                        sourceNode.disconnect();
                    } catch (e) {
                        console.warn(`[seekAudio] Error stopping source node for ${trackId}: ${e.message}`);
                    }
                }
                // ノードを再作成
                setupAudioNodes(trackId);
            });
        }
    
        pauseOffset = seekTimeClamped;
        isPlaying = false;
    
        if (playPauseButton) {
            playPauseButton.innerHTML = '<i class="fas fa-play"></i>';
            playPauseButton.setAttribute('aria-label', '再生');
        }
    
        // ソロ・ミュート状態を更新
        updateSoloMuteState();
    
        // 再生中だった場合は再生を再開
        if (wasPlaying) {
            playAudio();
        } else {
            stopAnimationLoop();
            updateTimeDisplay();
            updateLevelMeters();
            requestAnimationFrame(drawWaveform);
        }
    
        console.log(`[seekAudio] Seek finished. New pauseOffset: ${formatTime(pauseOffset)}`);
    }
    
    // --- ソロ・ミュート制御 (変更なし) ---
    function updateSoloMuteState() {
        const isAnySoloActive = soloedTracks.size > 0;
        tracks.forEach(track => {
            const muteNode = muteNodes[track.id];
            if (!muteNode) return;
            const trackElement = mixerElement?.querySelector(`.track[data-track-id="${track.id}"]`);
            if (!trackElement) return;
            const muteButton = trackElement.querySelector(`.mute-button`);
            const isMuted = muteButton && muteButton.getAttribute('aria-pressed') === 'true';
            const isSoloed = soloedTracks.has(track.id);
            let targetGain = 1.0;
            if (isMuted) { targetGain = 0.0; }
            else if (isAnySoloActive) { targetGain = isSoloed ? 1.0 : 0.0; }
            muteNode.gain.setTargetAtTime(targetGain, audioContext.currentTime, 0.015);
        });
    }

    // --- 波形・レベルメーター表示 ---

    // 全体用 AnalyserNode の設定 (変更なし)
    function setupGlobalAnalyser() {
        try {
            globalAnalyserNode = audioContext.createAnalyser();
            globalAnalyserNode.fftSize = 2048;
            globalAnalyserNode.smoothingTimeConstant = 0.8;
            globalAnalyserNode.connect(audioContext.destination);
            console.log("Global AnalyserNode setup complete.");
        } catch (e) {
            console.error("Failed to create Global AnalyserNode:", e);
            globalAnalyserNode = null;
        }
    }

    // ★ レベルメーター更新関数 (モバイル判定とwidth/height切り替え) ★
    function updateLevelMeters() {
        const isMobile = window.matchMedia("(max-width: 768px)").matches;

        Object.keys(analyserNodes).forEach(trackId => {
            const analyser = analyserNodes[trackId];
            const dataArray = meterDataArrays[trackId];
            const trackElement = mixerElement?.querySelector(`.track[data-track-id="${trackId}"]`);
            const meterBar = trackElement?.querySelector('.level-bar');

            if (analyser && dataArray && meterBar) {
                analyser.getFloatTimeDomainData(dataArray);
                let maxAmplitude = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    const absValue = Math.abs(dataArray[i]);
                    if (absValue > maxAmplitude) {
                        maxAmplitude = absValue;
                    }
                }
                // レベルメーターの最大値を計算
                const levelPercentage = Math.min(100, maxAmplitude * 100 * 3);

                // モバイル表示かデスクトップ表示かで更新するプロパティを切り替え
                if (isMobile) {
                    meterBar.style.height = '100%'; // 横向きなので高さは常に100%
                    meterBar.style.width = `${levelPercentage}%`; // 幅を更新
                } else {
                    meterBar.style.width = '100%'; // 縦向きなので幅は常に100%
                    meterBar.style.height = `${levelPercentage}%`; // 高さを更新
                }
            } else if(meterBar) {
                 // Analyserがない場合や停止時にメーターを0に
                 meterBar.style.height = '0%';
                 meterBar.style.width = '0%';
            }
        });
    }

    // アニメーションループ関数 (変更なし)
    function animationLoop() {
        if (!isPlaying && !isDraggingProgressBar) {
             animationFrameId = null;
             return;
        }
        drawWaveform();
        updateLevelMeters();
        animationFrameId = requestAnimationFrame(animationLoop);
    }
    // アニメーションループ開始関数 (変更なし)
    function startAnimationLoop() {
        if (!animationFrameId) {
            console.log("Starting animation loop.");
            animationFrameId = requestAnimationFrame(animationLoop);
        }
    }
    // アニメーションループ停止関数 (変更なし)
    function stopAnimationLoop() {
         if (animationFrameId) {
            console.log("Stopping animation loop.");
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
         }
    }

    // 波形描画関数 (変更なし)
    function drawWaveform() {
        if (!waveformCtx || !waveformCanvas) return;
        const width = waveformCanvas.width;
        const height = waveformCanvas.height;
        const halfHeight = height / 2;
        const gainFactor = 6.5;
        const amplitude = halfHeight * gainFactor;

        waveformCtx.clearRect(0, 0, width, height);
        waveformCtx.fillStyle = '#f0f0f0';
        waveformCtx.fillRect(0, 0, width, height);

        if (combinedWaveformData && combinedWaveformData.length > 0) {
            waveformCtx.lineWidth = 1; waveformCtx.fillStyle = '#cccccc'; waveformCtx.beginPath();
            const firstYMax = halfHeight - (combinedWaveformData[0]?.max || 0) * amplitude;
            waveformCtx.moveTo(0, firstYMax);
            combinedWaveformData.forEach((dataPoint, i) => {
                const x = (i / combinedWaveformData.length) * width;
                const yMax = halfHeight - (dataPoint.max * amplitude);
                waveformCtx.lineTo(x, yMax);
            });
            for (let i = combinedWaveformData.length - 1; i >= 0; i--) {
                const dataPoint = combinedWaveformData[i];
                const x = (i / combinedWaveformData.length) * width;
                const yMin = halfHeight - (dataPoint.min * amplitude);
                waveformCtx.lineTo(x, yMin);
            }
            waveformCtx.closePath(); waveformCtx.fill();

            let currentDisplayTime = pauseOffset;
            if (isPlaying) { currentDisplayTime = Math.max(0, audioContext.currentTime - startTime); }
            currentDisplayTime = Math.max(0, Math.min(currentDisplayTime, totalDuration));
            const progress = totalDuration > 0 ? currentDisplayTime / totalDuration : 0;
            const progressWidth = width * progress;

            if (progressWidth > 0) {
                waveformCtx.save();
                waveformCtx.beginPath(); waveformCtx.rect(0, 0, progressWidth, height); waveformCtx.clip();
                waveformCtx.fillStyle = '#ff5722'; waveformCtx.beginPath();
                const firstHighlightYMax = halfHeight - (combinedWaveformData[0]?.max || 0) * amplitude;
                waveformCtx.moveTo(0, firstHighlightYMax);
                 combinedWaveformData.forEach((dataPoint, i) => {
                    const x = (i / combinedWaveformData.length) * width;
                    const yMax = halfHeight - (dataPoint.max * amplitude);
                    waveformCtx.lineTo(x, yMax);
                });
                for (let i = combinedWaveformData.length - 1; i >= 0; i--) {
                    const dataPoint = combinedWaveformData[i];
                    const x = (i / combinedWaveformData.length) * width;
                    const yMin = halfHeight - (dataPoint.min * amplitude);
                    waveformCtx.lineTo(x, yMin);
                }
                waveformCtx.closePath(); waveformCtx.fill();
                waveformCtx.restore();
            }

            if (totalDuration > 0) {
                waveformCtx.fillStyle = 'rgba(0, 0, 0, 0.8)';
                const lineX = Math.round(progressWidth);
                waveformCtx.fillRect(lineX - 1, 0, 2, height);
            }
        } else {
            waveformCtx.fillStyle = 'rgba(0, 0, 0, 0.6)'; waveformCtx.textAlign = 'center';
            waveformCtx.font = '14px sans-serif';
            const message = isGeneratingWaveform ? '波形生成中...' : '波形データなし';
            waveformCtx.fillText(message, width / 2, height / 2);
        }

         let displayTime = pauseOffset;
        if (isPlaying) { displayTime = Math.max(0, audioContext.currentTime - startTime); }
        displayTime = Math.max(0, Math.min(displayTime, totalDuration));
        updateTimeDisplay(displayTime);
    }

    // 時間フォーマット関数 (変更なし)
    function formatTime(seconds) {
        const totalSeconds = Math.max(0, seconds);
        const minutes = Math.floor(totalSeconds / 60);
        const secs = Math.floor(totalSeconds % 60);
        return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }

    // 時間表示要素を更新 (変更なし)
    function updateTimeDisplay(currentTime = -1) {
        if (!timeDisplay) return;
        let displayTime = pauseOffset;
        if (currentTime >= 0) { displayTime = currentTime; }
        else if (isPlaying) { displayTime = Math.max(0, audioContext.currentTime - startTime); }
        displayTime = Math.max(0, Math.min(displayTime, totalDuration));
        timeDisplay.textContent = `${formatTime(displayTime)} / ${formatTime(totalDuration)}`;
    }

    // Canvas サイズ変更時の処理 (変更なし)
    function resizeCanvas() {
        const container = document.getElementById('waveform-container');
        if (!container || !waveformCanvas || !waveformCtx) return;
        const newWidth = container.clientWidth;
        const newHeight = container.clientHeight > 0 ? container.clientHeight : 100;
        if (waveformCanvas.width !== newWidth || waveformCanvas.height !== newHeight) {
            const oldWidth = waveformCanvas.width;
            waveformCanvas.width = newWidth;
            waveformCanvas.height = newHeight;
            console.log(`Canvas resized to ${newWidth}x${newHeight}`);
            if (oldWidth !== newWidth && newWidth > 0) {
                 console.log("Canvas width changed, regenerating waveform...");
                 generateStaticWaveform(newWidth);
            } else {
                 requestAnimationFrame(drawWaveform);
            }
        } else {
             requestAnimationFrame(drawWaveform);
        }
    }

    // --- イベントリスナー設定 (変更なしの部分が多い) ---
    function setupEventListeners() {
        // 再生コントロール (変更なし)
        if (playPauseButton) {
             playPauseButton.addEventListener('click', () => {
                 if (!isPlaying) { playAudio(); } else { pauseAudio(); }
             });
        }
        if (stopButton) {
             stopButton.addEventListener('click', stopAudio);
        }

        // ミキサーコントロール
        if (mixerElement) {
            // フェーダー操作 (GainNode更新のみ)
            mixerElement.addEventListener('input', (event) => {
                const target = event.target;
                if (target.classList.contains('fader')) {
                    const faderElement = target;
                    const trackId = faderElement.closest('.track')?.dataset.trackId;
                    if (trackId && gainNodes[trackId]) {
                        const value = parseFloat(faderElement.value);
                        gainNodes[trackId].gain.setTargetAtTime(value, audioContext.currentTime, 0.01);
                    }
                }
            });

            // ソロ・ミュートボタンのクリックイベントリスナー
            mixerElement.addEventListener('click', (event) => {
                const button = event.target.closest('button');
                if (!button) return;

                const trackElement = button.closest('.track');
                if (!trackElement) return;

                const trackId = trackElement.dataset.trackId;
                if (!trackId) return;

                if (button.classList.contains('solo-button')) {
                    const isPressed = button.getAttribute('aria-pressed') === 'true';
                    button.setAttribute('aria-pressed', String(!isPressed));

                    if (!isPressed) {
                        // ソロを有効にした場合、ミュートを解除
                        const muteButton = trackElement.querySelector('.mute-button');
                        if (muteButton) {
                            muteButton.setAttribute('aria-pressed', 'false');
                        }
                        soloedTracks.add(trackId);
                    } else {
                        soloedTracks.delete(trackId);
                    }

                    updateSoloMuteState();
                } else if (button.classList.contains('mute-button')) {
                    const isPressed = button.getAttribute('aria-pressed') === 'true';
                    button.setAttribute('aria-pressed', String(!isPressed));

                    if (!isPressed) {
                        // ミュートを有効にした場合、ソロを解除
                        const soloButton = trackElement.querySelector('.solo-button');
                        if (soloButton) {
                            soloButton.setAttribute('aria-pressed', 'false');
                        }
                        soloedTracks.delete(trackId);
                    }

                    updateSoloMuteState();
                }
            });
        }

        // 波形クリック/ドラッグによるシーク (アニメーションループ制御追加)
        if (waveformCanvas) {
            waveformCanvas.addEventListener('click', (event) => {
                if (isDraggingProgressBar || totalDuration <= 0) return;
                const rect = waveformCanvas.getBoundingClientRect();
                const x = event.clientX - rect.left;
                const clickRatio = Math.max(0, Math.min(1, x / waveformCanvas.width));
                const seekTime = clickRatio * totalDuration;
                seekAudio(seekTime);
            });
            waveformCanvas.addEventListener('mousedown', (event) => {
                if (totalDuration <= 0 || event.button !== 0) return;
                isDraggingProgressBar = true;
                waveformCanvas.style.cursor = 'grabbing';
                const rect = waveformCanvas.getBoundingClientRect();
                const x = event.clientX - rect.left;
                const dragStartRatio = Math.max(0, Math.min(1, x / waveformCanvas.width));
                pauseOffset = dragStartRatio * totalDuration;
                startAnimationLoop();
                document.body.style.userSelect = 'none';
            });
            waveformCanvas.style.cursor = 'pointer';
            waveformCanvas.addEventListener('selectstart', (e) => e.preventDefault());
        }

        // ウィンドウレベルのイベントリスナー (アニメーションループ制御追加)
        window.addEventListener('mousemove', (event) => {
            if (!isDraggingProgressBar || totalDuration <= 0 || !waveformCanvas) return;
            const rect = waveformCanvas.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const dragRatio = Math.max(0, Math.min(1, x / waveformCanvas.width));
            pauseOffset = dragRatio * totalDuration;
        });
        window.addEventListener('mouseup', (event) => {
            if (isDraggingProgressBar) {
                isDraggingProgressBar = false;
                if (waveformCanvas) waveformCanvas.style.cursor = 'pointer';
                document.body.style.userSelect = '';
                seekAudio(pauseOffset);
            }
        });

        // ウィンドウリサイズ (変更なし)
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                console.log("Window resize detected, updating canvas...");
                resizeCanvas();
            }, 150);
        });

         // タブ非表示で一時停止 (変更なし)
         document.addEventListener('visibilitychange', () => {
             if (document.hidden && isPlaying) {
                 console.log("Tab became hidden, pausing audio.");
                 pauseAudio();
             }
         });
    }

    // --- アプリケーション開始 ---
    init().catch(error => {
        console.error("Initialization failed:", error);
        hideLoading();
        const errorDisplay = document.getElementById('error-message');
        if (errorDisplay) {
             errorDisplay.textContent = "初期化に失敗しました。コンソールを確認してください。";
             errorDisplay.style.display = 'block';
        } else {
             alert("初期化中にエラーが発生しました。");
        }
    });

}); // End DOMContentLoaded
