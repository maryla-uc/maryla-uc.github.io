document.addEventListener('DOMContentLoaded', () => {
    const backgroundColorSelect = document.getElementById('backgroundColor');
    const foregroundImageSelect = document.getElementById('foregroundImage');
    const alphaMaskSelect = document.getElementById('alphaMask');
    const blendingColorSpaceSelect = document.getElementById('blendingColorSpace'); // New dropdown
    const transferFunctionSelect = document.getElementById('transferFunction');
    const transferFunctionGroup = document.getElementById('transferFunctionGroup'); // To hide/show
    const blendCanvas = document.getElementById('blendCanvas');
    const ctx = blendCanvas.getContext('2d');

    let foregroundImage = new Image();
    let alphaMaskImage = new Image();

    // --- Transfer Function Conversions (CICP-based + HDR/Generic Gamma) ---

    // sRGB / IEC 61966-2-1 (CICP 6)
    function sRGBToLinear(c) {
        c /= 255;
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    function linearTosRGB(c) {
        c = Math.max(0, Math.min(1, c)); // Clamp to 0-1
        return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : (1.055 * Math.pow(c, 1 / 2.4) - 0.055)));
    }

    // BT.709 (CICP 1)
    function BT709ToLinear(c) {
        c /= 255;
        return c < 0.081 ? c / 4.5 : Math.pow((c + 0.099) / 1.099, 1 / 0.45);
    }

    function linearToBT709(c) {
        c = Math.max(0, Math.min(1, c)); // Clamp to 0-1
        return Math.round(255 * (c < 0.018 ? c * 4.5 : (1.099 * Math.pow(c, 0.45) - 0.099)));
    }

    // PQ (Perceptual Quantizer - SMPTE ST 2084)
    const m1 = 2610 / 16384;
    const m2 = 2523 / 4096 * 128;
    const c1 = 3424 / 4096;
    const c2 = 2374 / 4096 * 128;
    const c3 = 32 / 4096 * 128;

    function PQToLinear(c_nits) {
        const normalized_c = c_nits / 10000; // Assuming 0-255 maps to 0-10000 nits
        const p = Math.pow(normalized_c, 1 / m2);
        const l = Math.pow(Math.max(0, p - c1), 1 / m1);
        return l; // Returns linear light normalized 0-1
    }

    function linearToPQ(l_norm) {
        l_norm = Math.max(0, l_norm);
        const p = Math.pow(l_norm, m1);
        const c = Math.pow((c1 + p) / (1 + c2 * p), m2);
        return c; // Returns value normalized 0-1 relative to 10000 nits
    }

    // HLG (Hybrid Log-Gamma - ARIB STD-B67)
    const a = 0.17883277;
    const b = 0.28466892;
    const c_hlg = 0.55991073;

    function HLGToLinear(c_input_norm) { // c_input_norm is 0-1 normalized signal E_prime
        if (c_input_norm <= 0.5) {
            return 3 * Math.pow(c_input_norm, 2);
        } else {
            return (Math.exp((c_input_norm - c_hlg) / a) + b);
        }
    }

    function linearToHLG(L_norm) { // L_norm is linear light normalized 0-1
        L_norm = Math.max(0, Math.min(1, L_norm));
        if (L_norm <= 1/12) {
            return Math.sqrt(L_norm / 3);
        } else {
            return a * Math.log(L_norm - b) + c_hlg;
        }
    }

    // Generic Gamma Function
    function gammaToLinear(c, gamma) {
        c /= 255;
        return Math.pow(c, gamma);
    }

    function linearToGamma(l, gamma) {
        l = Math.max(0, Math.min(1, l));
        return Math.round(255 * Math.pow(l, 1 / gamma));
    }


    // --- YUV Conversions (BT.709 coefficients used as standard for digital video) ---

    // RGB to YUV (Full Range: Y:0-255, U/V:0-255) - often scaled from 16-235/16-240
    // Based on BT.709 coefficients for Y. For U/V, standard formulas.
    function rgbToYuvFullRange(R, G, B) {
        const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        const U = -0.09991 * R - 0.33609 * G + 0.436 * B + 128; // U and V offsets to keep them positive
        const V = 0.615 * R - 0.55861 * G - 0.05639 * B + 128;
        return [Y, U, V];
    }

    // YUV to RGB (Full Range)
    function yuvToRgbFullRange(Y, U, V) {
        U -= 128;
        V -= 128;
        const R = Y + 1.28033 * V;
        const G = Y - 0.21482 * U - 0.38059 * V;
        const B = Y + 2.12798 * U;
        return [R, G, B];
    }

    // RGB to YUV (Limited Range / Studio Swing: Y:16-235, U/V:16-240) - BT.709
    function rgbToYuvLimitedRange(R, G, B) {
        const Y = 16 + 0.182585 * R + 0.614231 * G + 0.062002 * B;
        const U = 128 - 0.100644 * R - 0.338573 * G + 0.439217 * B;
        const V = 128 + 0.439217 * R - 0.398942 * G - 0.040275 * B;
        return [Y, U, V];
    }

    // YUV to RGB (Limited Range)
    function yuvToRgbLimitedRange(Y, U, V) {
        Y -= 16;
        U -= 128;
        V -= 128;
        const R = 1.164383 * Y + 1.596027 * V;
        const G = 1.164383 * Y - 0.391762 * U - 0.812968 * V;
        const B = 1.164383 * Y + 2.017232 * U;
        return [R, G, B];
    }

    // --- Main Blending Logic ---

    // Function to parse hex color to RGB array [R, G, B]
    function hexToRgb(hex) {
        const bigint = parseInt(hex.slice(1), 16);
        const r = (bigint >> 16) & 255;
        const g = (bigint >> 8) & 255;
        const b = bigint & 255;
        return [r, g, b];
    }

    // Function to draw everything on the canvas
    const drawCanvas = () => {
        const bgColor = backgroundColorSelect.value;
        const [bgR_display, bgG_display, bgB_display] = hexToRgb(bgColor); // Stored as 0-255 for display
        const selectedTransferFunctionOption = transferFunctionSelect.value;
        const selectedBlendingColorSpace = blendingColorSpaceSelect.value;

        // Hide/show transfer function dropdown based on blending color space
        if (selectedBlendingColorSpace.startsWith('YUV')) {
            transferFunctionGroup.style.display = 'none';
        } else {
            transferFunctionGroup.style.display = 'flex';
        }

        // Clear the canvas
        ctx.clearRect(0, 0, blendCanvas.width, blendCanvas.height);

        // Draw background color (initial display, then overwritten by blend)
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, blendCanvas.width, blendCanvas.height);

        // Check if both foreground image and alpha mask are loaded
        if (foregroundImage.complete && foregroundImage.naturalWidth > 0 &&
            alphaMaskImage.complete && alphaMaskImage.naturalWidth > 0) {

            blendCanvas.width = foregroundImage.naturalWidth;
            blendCanvas.height = foregroundImage.naturalHeight;

            // Create temporary canvases for image data
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = blendCanvas.width;
            tempCanvas.height = blendCanvas.height;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.drawImage(foregroundImage, 0, 0, tempCanvas.width, tempCanvas.height);
            const foregroundData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
            const foregroundPixels = foregroundData.data;

            const maskTempCanvas = document.createElement('canvas');
            maskTempCanvas.width = blendCanvas.width;
            maskTempCanvas.height = blendCanvas.height;
            const maskTempCtx = maskTempCanvas.getContext('2d');
            maskTempCtx.drawImage(alphaMaskImage, 0, 0, maskTempCanvas.width, maskTempCanvas.height);
            const maskData = maskTempCtx.getImageData(0, 0, maskTempCanvas.width, maskTempCanvas.height);
            const maskPixels = maskData.data;

            const blendedImageData = ctx.createImageData(blendCanvas.width, blendCanvas.height);
            const blendedPixels = blendedImageData.data;

            for (let i = 0; i < foregroundPixels.length; i += 4) {
                const fgR_display = foregroundPixels[i];
                const fgG_display = foregroundPixels[i + 1];
                const fgB_display = foregroundPixels[i + 2];
                const fgA_mask = maskPixels[i]; // Using Red channel of mask as alpha (0-255)
                const alpha = fgA_mask / 255; // Alpha is always linear (0-1)

                let finalR_display, finalG_display, finalB_display; // Final values to put on canvas

                if (selectedBlendingColorSpace.startsWith('YUV')) {
                    // Convert RGB inputs to YUV first
                    let fgY, fgU, fgV;
                    let bgY, bgU, bgV;

                    if (selectedBlendingColorSpace === 'YUV_Full') {
                        [fgY, fgU, fgV] = rgbToYuvFullRange(fgR_display, fgG_display, fgB_display);
                        [bgY, bgU, bgV] = rgbToYuvFullRange(bgR_display, bgG_display, bgB_display);
                    } else { // YUV_Limited
                        [fgY, fgU, fgV] = rgbToYuvLimitedRange(fgR_display, fgG_display, fgB_display);
                        [bgY, bgU, bgV] = rgbToYuvLimitedRange(bgR_display, bgG_display, fgB_display); // Typo: Should be bgB_display
                    }
                    // Corrected line:
                    if (selectedBlendingColorSpace === 'YUV_Full') {
                        [fgY, fgU, fgV] = rgbToYuvFullRange(fgR_display, fgG_display, fgB_display);
                        [bgY, bgU, bgV] = rgbToYuvFullRange(bgR_display, bgG_display, bgB_display);
                    } else { // YUV_Limited
                        [fgY, fgU, fgV] = rgbToYuvLimitedRange(fgR_display, fgG_display, fgB_display);
                        [bgY, bgU, bgV] = rgbToYuvLimitedRange(bgR_display, bgG_display, bgB_display);
                    }


                    // Perform blending in YUV space
                    const blendedY = fgY * alpha + bgY * (1 - alpha);
                    const blendedU = fgU * alpha + bgU * (1 - alpha);
                    const blendedV = fgV * alpha + bgV * (1 - alpha);

                    // Convert blended YUV back to RGB for display
                    if (selectedBlendingColorSpace === 'YUV_Full') {
                        [finalR_display, finalG_display, finalB_display] = yuvToRgbFullRange(blendedY, blendedU, blendedV);
                    } else { // YUV_Limited
                        [finalR_display, finalG_display, finalB_display] = yuvToRgbLimitedRange(blendedY, blendedU, blendedV);
                    }

                    // Clamp values to 0-255
                    blendedPixels[i] = Math.round(Math.max(0, Math.min(255, finalR_display)));
                    blendedPixels[i + 1] = Math.round(Math.max(0, Math.min(255, finalG_display)));
                    blendedPixels[i + 2] = Math.round(Math.max(0, Math.min(255, finalB_display)));

                } else { // selectedBlendingColorSpace === 'RGB'
                    if (selectedTransferFunctionOption === 'Gamma_Space_Blending') {
                        // Perform blending directly in gamma-compressed space
                        blendedPixels[i] = Math.round(fgR_display * alpha + bgR_display * (1 - alpha));
                        blendedPixels[i + 1] = Math.round(fgG_display * alpha + bgG_display * (1 - alpha));
                        blendedPixels[i + 2] = Math.round(fgB_display * alpha + bgB_display * (1 - alpha));

                    } else { // Linear blending with a specific transfer function in RGB space
                        // Linearize foreground and background using the selected transfer function
                        // Assuming source images and background color are sRGB for initial linearization
                        const linearizeInput = (val, tf) => {
                            switch (tf) {
                                case 'sRGB_IEC_61966_2_1': return sRGBToLinear(val);
                                case 'BT_709': return BT709ToLinear(val);
                                case 'PQ': return PQToLinear(val / 255 * 10000);
                                case 'HLG': return HLGToLinear(val / 255);
                                case 'Gamma_2_2': return gammaToLinear(val, 2.2);
                                case 'Gamma_2_4': return gammaToLinear(val, 2.4);
                                case 'Gamma_2_8': return gammaToLinear(val, 2.8);
                                default: return val / 255;
                            }
                        };

                        const delinearizeOutput = (val_linear, tf) => {
                            switch (tf) {
                                case 'sRGB_IEC_61966_2_1': return linearTosRGB(val_linear);
                                case 'BT_709': return linearToBT709(val_linear);
                                case 'PQ': return Math.round(linearToPQ(val_linear) / 10000 * 255);
                                case 'HLG': return Math.round(linearToHLG(val_linear) * 255);
                                case 'Gamma_2_2': return linearToGamma(val_linear, 2.2);
                                case 'Gamma_2_4': return linearToGamma(val_linear, 2.4);
                                case 'Gamma_2_8': return linearToGamma(val_linear, 2.8);
                                default: return Math.round(val_linear * 255);
                            }
                        };

                        const linearFgR = linearizeInput(fgR_display, selectedTransferFunctionOption);
                        const linearFgG = linearizeInput(fgG_display, selectedTransferFunctionOption);
                        const linearFgB = linearizeInput(fgB_display, selectedTransferFunctionOption);

                        const linearBgR = linearizeInput(bgR_display, selectedTransferFunctionOption);
                        const linearBgG = linearizeInput(bgG_display, selectedTransferFunctionOption);
                        const linearBgB = linearizeInput(bgB_display, selectedTransferFunctionOption);

                        // Perform blending in linear space
                        const blendedR_linear = linearFgR * alpha + linearBgR * (1 - alpha);
                        const blendedG_linear = linearFgG * alpha + linearBgG * (1 - alpha);
                        const blendedB_linear = linearFgB * alpha + linearBgB * (1 - alpha);

                        // Delinearize the result back to the selected transfer function's gamma space for display
                        blendedPixels[i] = delinearizeOutput(blendedR_linear, selectedTransferFunctionOption);
                        blendedPixels[i + 1] = delinearizeOutput(blendedG_linear, selectedTransferFunctionOption);
                        blendedPixels[i + 2] = delinearizeOutput(blendedB_linear, selectedTransferFunctionOption);
                    }
                }

                // Always set full opacity for the final blended image for display
                blendedPixels[i + 3] = 255;
            }

            // Put the final blended image data onto the main canvas
            ctx.putImageData(blendedImageData, 0, 0);

        } else {
            // Display a message or handle cases where images are not loaded
            ctx.font = '20px Arial';
            ctx.fillStyle = '#666';
            ctx.fillText('Loading images...', blendCanvas.width / 2 - 80, blendCanvas.height / 2);
        }
    };

    // Event listeners for changes in dropdowns
    backgroundColorSelect.addEventListener('change', drawCanvas);
    foregroundImageSelect.addEventListener('change', () => {
        foregroundImage.src = foregroundImageSelect.value;
    });
    alphaMaskSelect.addEventListener('change', () => {
        alphaMaskImage.src = alphaMaskSelect.value;
    });
    blendingColorSpaceSelect.addEventListener('change', drawCanvas); // New listener
    transferFunctionSelect.addEventListener('change', drawCanvas);

    // Set up image loading handlers
    foregroundImage.onload = drawCanvas;
    foregroundImage.onerror = () => console.error("Error loading foreground image");

    alphaMaskImage.onload = drawCanvas;
    alphaMaskImage.onerror = () => console.error("Error loading alpha mask image");

    // Initial load of images
    foregroundImage.src = foregroundImageSelect.value;
    alphaMaskImage.src = alphaMaskSelect.value;

    // Initial draw
    drawCanvas();
});