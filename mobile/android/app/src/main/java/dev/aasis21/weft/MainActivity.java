package dev.aasis21.weft;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM || getBridge() == null) {
            return;
        }

        // Edge-to-edge windows must resize the WebView itself, not just its visual viewport.
        View content = (View) getBridge().getWebView().getParent();
        int imeType = WindowInsetsCompat.Type.ime();
        int restingBottom = content.getPaddingBottom();
        ViewCompat.setOnApplyWindowInsetsListener(content, (view, insets) -> {
            int bottom = restingBottom + insets.getInsets(imeType).bottom;
            if (view.getPaddingBottom() != bottom) {
                view.setPadding(view.getPaddingLeft(), view.getPaddingTop(), view.getPaddingRight(), bottom);
            }
            // Only the parent handles the keyboard. WebView still receives the other system insets.
            return new WindowInsetsCompat.Builder(insets).setInsets(imeType, Insets.NONE).build();
        });
        ViewCompat.requestApplyInsets(content);
    }
}
